// The "tools" the Ollama chat assistant can call.
//
// READ_REGISTRY is read-only — plain reads of data already visible to any
// signed-in user in the dashboard, so `config.ollama.tools` grants the
// model no access a person using the app doesn't already have.
//
// ACTION_REGISTRY *changes something*. It's gated twice more:
// `config.ollama.actions` (off by default, and refused unless password
// protection is on), and every call still has to be confirmed by a human
// in chat before it runs (see ollamaActions.js / ollamaChat.js). An action
// entry has `prepare(args)` — validates and builds the confirmation label,
// or returns { error } to abort before any button is shown — and
// `execute(payload)`, which runs once confirmed.
//
// Adding a read tool = one entry in READ_REGISTRY (name, footnote label,
// description the model reads, JSON-schema params, handler).

import { getStatusSnapshot } from './healthChecker.js';
import { getHostHealthSnapshot } from './host.js';
import { getDevices } from './devices.js';
import { getContainerLogs, listDockerContainers, getContainerStats } from './docker.js';
import { loadConfig } from './config.js';
import { readRecentActivity } from './activityLog.js';
import { searchSharedFolder, getRecentUploads } from './fileShare.js';
import { getScanState, startScan } from './discovery.js';
import { lanAddresses } from './net.js';
import { getTailscaleDetail } from './tailscale.js';
import { listModels, listRunningModels } from './ollama.js';
import { getGameStatus, runGameCommand } from './gameServers.js';
import { getNowPlaying, sendCommand as jellyfinCommand, isConfigured as jellyfinConfigured } from './jellyfin.js';
import { sendMagicPacket } from './wol.js';
import { controlService } from './serviceControl.js';
import { sendCustomAlert } from './alerts.js';
import { buildWorkflow, generate as comfyGenerate } from './comfyImage.js';
import { ensureUploadDir, UPLOAD_DIR } from './chat.js';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import nodeCrypto from 'node:crypto';
import { addService, addConnection } from './serviceStore.js';
import { addWidget } from './widgetStore.js';
import { sanitizeWidget } from './widgets.js';
import { runSnippet } from './snippets.js';

// Small models routinely fill an *optional* string param with a sentinel
// ("none", "null", "N/A") instead of omitting it. Treat those as "not given".
function optionalArg(v) {
  const s = String(v ?? '').trim();
  return /^(|none|null|n\/a|na|any|undefined)$/i.test(s) ? '' : s;
}

// Shared name/id resolver — a few handlers all do this.
async function resolveService(config, q) {
  const query = String(q || '').toLowerCase();
  if (!query) return null;
  return (
    config.services.find((s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query) ||
    config.services.find((s) => s.name.toLowerCase().includes(query)) ||
    null
  );
}

// ---------- Handlers ----------

async function listServices(args) {
  const config = await loadConfig();
  const snap = new Map(getStatusSnapshot().map((s) => [s.id, s]));
  const groupName = new Map(config.groups.map((g) => [g.id, g.name]));
  const svcName = new Map(config.services.map((s) => [s.id, s.name]));

  let rows = config.services.map((s) => {
    const st = snap.get(s.id) || {};
    return {
      name: s.name,
      group: groupName.get(s.group) || null,
      url: s.url,
      status: st.effectiveStatus || st.status || 'unknown',
      latencyMs: st.latencyMs ?? null,
      uptimePercent: st.uptimePercent ?? null,
      error: st.error || null,
      degradedBy: (st.degradedBy || []).map((id) => svcName.get(id) || id),
    };
  });
  if (args.status) rows = rows.filter((r) => r.status === args.status);
  return { count: rows.length, services: rows };
}

function getHostHealth() {
  const h = getHostHealthSnapshot();
  if (!h) return { error: 'host stats have not been sampled yet' };
  const gb = (n) => +(n / 1024 ** 3).toFixed(1);
  const pct = (used, total) => (total ? Math.round((used / total) * 100) : null);
  return {
    cpuPercent: h.cpuPercent,
    memory: { usedGB: gb(h.memory.used), totalGB: gb(h.memory.total), percent: pct(h.memory.used, h.memory.total) },
    disk: h.disk
      ? { path: h.disk.path, usedGB: gb(h.disk.used), totalGB: gb(h.disk.total), percent: pct(h.disk.used, h.disk.total) }
      : null,
    hostUptimeHours: +(h.uptimeSeconds / 3600).toFixed(1),
    hostname: h.hostname,
    platform: `${h.platform} (${h.arch})`,
    missionControl: {
      processUptimeHours: +(h.mc.uptimeSeconds / 3600).toFixed(1),
      memoryRssMB: Math.round(h.mc.memoryRss / 1024 ** 2),
      connectedDevices: h.mc.wsClients,
      eventLoopLagMs: h.mc.eventLoopLagMs,
    },
  };
}

function listDevices() {
  return {
    devices: getDevices().map((d) => ({
      device: d.label,
      ip: d.ip,
      connectedNow: d.online,
      lastSeen: d.lastSeen,
      requests: d.requestCount,
    })),
  };
}

async function getConnections() {
  const config = await loadConfig();
  const name = new Map(config.services.map((s) => [s.id, s.name]));
  const n = (id) => name.get(id) || id;
  return {
    connections: config.connections.map((c) => ({
      type: c.type,
      label: c.label || null,
      meaning:
        c.type === 'depends-on'
          ? `${n(c.from)} depends on ${n(c.to)} (if ${n(c.to)} goes offline, ${n(c.from)} shows as degraded)`
          : `${n(c.from)} and ${n(c.to)} are related`,
    })),
  };
}

async function getServiceLogs(args) {
  if (!args.service) return { error: 'a service name or id is required' };
  const config = await loadConfig();
  const q = String(args.service).toLowerCase();
  const svc =
    config.services.find((s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q) ||
    config.services.find((s) => s.name.toLowerCase().includes(q));
  if (!svc) return { error: `no service matching "${args.service}"` };
  if (svc.controller?.type !== 'docker' || !svc.controller.container) {
    return { note: `"${svc.name}" has no Docker container configured, so there are no logs to read here.` };
  }
  try {
    const logs = (await getContainerLogs(svc.controller.container, { tail: 60 })).trim();
    return { service: svc.name, container: svc.controller.container, logs: logs.slice(-4000) || '(empty)' };
  } catch (err) {
    return { error: `couldn't fetch logs for "${svc.name}": ${err.message}` };
  }
}

async function getActivityLog(args) {
  const sinceHours = Number(args.since_hours) > 0 ? Number(args.since_hours) : 24;
  const entries = await readRecentActivity({ sinceHours, category: args.category || null, limit: 60 });
  return { window: `${sinceHours}h`, count: entries.length, entries };
}

function svcHistorySummary(name, entry) {
  const samples = entry?.history || []; // up to 30 status strings, oldest -> newest
  let transitions = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i] !== samples[i - 1]) transitions += 1;
  return {
    name,
    status: entry?.effectiveStatus || entry?.status || 'unknown',
    uptimePercent: entry?.uptimePercent ?? null,
    lastChecked: entry?.lastChecked ?? null,
    recentSamples: samples,
    transitionsInSamples: transitions, // higher = flappier lately
    currentError: entry?.error || null,
  };
}

async function getUptimeHistory(args) {
  const config = await loadConfig();
  const byId = new Map(getStatusSnapshot().map((e) => [e.id, e]));
  if (args.service) {
    const q = String(args.service).toLowerCase();
    const svc =
      config.services.find((s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q) ||
      config.services.find((s) => s.name.toLowerCase().includes(q));
    if (!svc) return { error: `no service matching "${args.service}"` };
    return svcHistorySummary(svc.name, byId.get(svc.id));
  }
  return { services: config.services.map((s) => svcHistorySummary(s.name, byId.get(s.id))) };
}

async function searchFiles(args) {
  if (!args.query) return { error: 'a search query is required' };
  const config = await loadConfig();
  if (!config.sharedFolder?.enabled) return { note: 'the shared folder is turned off in settings' };
  const { items, truncated } = await searchSharedFolder(config, args.query);
  return {
    count: items.length,
    matches: items.map((i) => ({ path: i.path, type: i.type, size: i.size })),
    ...(truncated && {
      incomplete:
        'the search stopped at its scan limit before covering the whole folder — there may be more matches. A more specific term would search deeper.',
    }),
  };
}

function recentUploads() {
  const uploads = getRecentUploads();
  return { count: uploads.length, uploads };
}

const SCAN_WAIT_CAP_MS = 75000;
const SCAN_FRESH_MS = 5 * 60 * 1000;

async function networkScan(args) {
  let state = getScanState();
  const finishedRecently = state.finishedAt && Date.now() - state.finishedAt < SCAN_FRESH_MS;
  if (!state.running && (args.rescan || (!finishedRecently && !state.results.length))) {
    state = startScan();
  }
  const deadline = Date.now() + SCAN_WAIT_CAP_MS;
  while (getScanState().running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  state = getScanState();
  const ownAddrs = lanAddresses();
  return {
    stillScanning: state.running,
    hostsScanned: state.progress,
    hostsTotal: state.total,
    error: state.error || null,
    devices: state.results.map((r) => ({
      ip: r.ip,
      hostname: r.hostname || null,
      mac: r.mac || null,
      openPorts: (r.ports || []).map((p) => p.label),
    })),
    // The scanner deliberately skips this machine's own addresses, so
    // services running *here* never show up in a scan — steer the model
    // to the right tool instead of letting it conclude "only the router".
    note: `The machine Mission Control runs on (${ownAddrs.join(', ') || 'this host'}) is not part of the scan. For services running there, use list_services or get_host_health.`,
  };
}

async function listContainers() {
  try {
    const containers = await listDockerContainers();
    return { count: containers.length, containers };
  } catch (err) {
    return { error: err.message };
  }
}

async function containerStats(args) {
  if (!args.container) return { error: 'a container name or id is required' };
  try {
    return { container: args.container, ...(await getContainerStats(args.container)) };
  } catch (err) {
    return { error: err.message };
  }
}

function tailscaleStatus() {
  return getTailscaleDetail();
}

async function ollamaModels() {
  const config = await loadConfig();
  try {
    const models = await listModels(config.ollama.baseUrl);
    return {
      count: models.length,
      models: models.map((m) => ({
        name: m.name,
        sizeGB: m.size ? +(m.size / 1024 ** 3).toFixed(1) : null,
        parameterSize: m.parameterSize || null,
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function loadedModels() {
  const config = await loadConfig();
  try {
    const loaded = await listRunningModels(config.ollama.baseUrl);
    return loaded.length ? { loaded } : { loaded: [], note: 'no models are currently held in memory' };
  } catch (err) {
    return { error: err.message };
  }
}

async function getSettings() {
  const config = await loadConfig();
  return {
    healthCheck: {
      intervalSeconds: Math.round((config.settings.healthCheckIntervalMs ?? 15000) / 1000),
      timeoutSeconds: Math.round((config.settings.healthCheckTimeoutMs ?? 3000) / 1000),
    },
    sharedFolder: {
      enabled: config.sharedFolder.enabled,
      path: config.sharedFolder.path,
      allowUpload: config.sharedFolder.allowUpload,
      allowDelete: config.sharedFolder.allowDelete,
    },
    externalAlerts: {
      enabled: config.alerts.enabled,
      webhookConfigured: !!config.alerts.webhookUrl, // the URL itself is withheld — it can carry a secret token
      format: config.alerts.format,
    },
    passwordProtection: !!config.auth?.enabled,
    ipAllowlist: {
      enabled: config.security?.ipAllowlist?.enabled ?? false,
      ranges: config.security?.ipAllowlist?.subnets ?? [],
    },
    serviceControlEnabled: config.security?.serviceControl?.enabled ?? false,
    assistant: {
      model: config.ollama?.model || null,
      trigger: config.ollama?.trigger,
      liveDataLookups: !!config.ollama?.tools,
    },
  };
}

// ---------- Ops roadmap Phase 3a: game servers / Jellyfin / widgets / snippets ----------
// All plain reads of things already on the dashboard (a game service's card,
// the Board's now-playing + widget tiles, the Snippets settings tab).

const fmtClock = (s) => {
  if (!s || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

async function getGameServers() {
  const config = await loadConfig();
  const games = config.services.filter((s) => s.game?.kind);
  if (!games.length) return { count: 0, servers: [], note: 'no services are set up as game servers' };
  const servers = await Promise.all(
    games.map(async (s) => {
      try {
        const st = await getGameStatus(s.game, { full: true });
        return {
          name: s.name,
          kind: s.game.kind,
          online: true,
          players: st.count ?? (st.players ? st.players.length : 0),
          maxPlayers: st.max ?? null,
          playerNames: (st.players || []).map((p) => (typeof p === 'string' ? p : p.name)),
          map: st.mapName || null,
          gametype: st.gametype || null,
          serverName: st.serverName || null,
        };
      } catch (err) {
        return { name: s.name, kind: s.game.kind, online: false, error: err.message };
      }
    })
  );
  return { count: servers.length, servers };
}

async function nowPlaying() {
  const config = await loadConfig();
  if (!jellyfinConfigured(config)) {
    return { note: 'Jellyfin is not connected (Settings → Jellyfin) — nothing to report' };
  }
  try {
    const sessions = await getNowPlaying(config);
    if (!sessions.length) return { count: 0, sessions: [], note: 'nothing is playing on Jellyfin right now' };
    return {
      count: sessions.length,
      sessions: sessions.map((s) => ({
        title: s.title,
        subtitle: s.subtitle || null,
        type: s.type || null,
        device: s.deviceName,
        user: s.userName || null,
        state: s.isPaused ? 'paused' : 'playing',
        progress: `${fmtClock(s.positionSec)} / ${fmtClock(s.durationSec)}`,
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function listWidgets() {
  const config = await loadConfig();
  const widgets = config.widgets || [];
  const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const summary = (w) => {
    switch (w.type) {
      case 'iframe': return w.url;
      case 'links': return plural((w.links || []).length, 'link');
      case 'fetch': return w.url;
      case 'note': return (w.markdown || '').slice(0, 60).replace(/\s+/g, ' ');
      case 'service-status': return plural((w.serviceIds || []).length, 'service');
      case 'clock': return w.timezone || 'local time';
      case 'countdown': return w.target ? `to ${w.target}` : 'no target';
      case 'photo': return w.folder || 'shared folder root';
      case 'docker': return (w.containers || []).length ? plural(w.containers.length, 'container') : 'all containers';
      default: return null;
    }
  };
  return {
    count: widgets.length,
    widgets: widgets.map((w) => ({
      type: w.type,
      title: w.title || null,
      size: w.size || 'sm',
      detail: summary(w),
    })),
  };
}

async function listSnippets() {
  const config = await loadConfig();
  const snippets = config.snippets || [];
  const runnerOn = !!config.security?.snippetRunner?.enabled && !!config.auth?.enabled;
  return {
    count: snippets.length,
    snippets: snippets.map((s) => ({ label: s.label, command: s.command, cwd: s.cwd || null })),
    runnerEnabled: runnerOn,
    ...(snippets.length && !runnerOn && {
      note: 'the snippet runner is off (Settings → Snippets, needs password protection) — these are saved but can\'t be run',
    }),
  };
}

// ---------- Registry ----------

const NO_PARAMS = { type: 'object', properties: {} };

const READ_REGISTRY = [
  {
    name: 'list_services',
    label: 'service status',
    description:
      'List the monitored services with their current health (online / offline / degraded / checking / unmonitored), latency, and uptime. Use this for any question about what is up, down, slow, or degraded.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional: only return services currently in this status.',
          enum: ['online', 'offline', 'degraded', 'checking', 'unmonitored'],
        },
      },
    },
    handler: listServices,
  },
  {
    name: 'get_host_health',
    label: 'host health',
    description:
      "Current CPU, memory, and disk usage of the machine Mission Control runs on, plus Mission Control's own process stats.",
    parameters: NO_PARAMS,
    handler: getHostHealth,
  },
  {
    name: 'list_devices',
    label: 'connected devices',
    description:
      'Devices that have connected to Mission Control recently — browser/OS label, whether connected right now, last seen, request count.',
    parameters: NO_PARAMS,
    handler: listDevices,
  },
  {
    name: 'get_connections',
    label: 'service connections',
    description:
      'The links between services — which service "depends on" which (a dependency going down degrades the dependent), and which are just "related".',
    parameters: NO_PARAMS,
    handler: getConnections,
  },
  {
    name: 'get_service_logs',
    label: 'container logs',
    description:
      'Recent log lines for a service that has a Docker container configured. Returns a note if the named service has no container.',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Service name or id to fetch logs for.' } },
      required: ['service'],
    },
    handler: getServiceLogs,
  },
  {
    name: 'get_activity_log',
    label: 'activity log',
    description:
      'The recent audit trail — services going up/down, new devices, config and security changes, sign-ins. Use this for "what happened overnight / recently / while I was away".',
    parameters: {
      type: 'object',
      properties: {
        since_hours: { type: 'number', description: 'How far back to look, in hours. Default 24.' },
        category: {
          type: 'string',
          description: 'Optional filter by kind of event.',
          enum: ['service', 'health', 'device', 'auth', 'security', 'settings', 'chat', 'code', 'file', 'config', 'discovery', 'system', 'control', 'group', 'timesheet', 'schedule'],
        },
      },
    },
    handler: getActivityLog,
  },
  {
    name: 'get_uptime_history',
    label: 'uptime history',
    description:
      'Recent up/down sample history and uptime percentage for a service (or all services if none is named). Use this for "has X been flapping / stable / how reliable is it".',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Optional service name or id. Omit for all services.' } },
    },
    handler: getUptimeHistory,
  },
  {
    name: 'search_shared_folder',
    label: 'shared folder search',
    description: "Search the shared folder for files/folders whose name contains a term. Use for \"is there a file called X\", \"find my notes about Y\".",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Substring to look for in file and folder names.' } },
      required: ['query'],
    },
    handler: searchFiles,
  },
  {
    name: 'get_recent_uploads',
    label: 'recent uploads',
    description: 'The files most recently uploaded to the shared folder through Mission Control, newest first.',
    parameters: NO_PARAMS,
    handler: recentUploads,
  },
  {
    name: 'run_network_scan',
    label: 'network scan',
    description:
      'Scan the local network for devices with common self-hosted ports open. Reuses a scan from the last 5 minutes unless rescan is true. Can take up to ~75 seconds.',
    parameters: {
      type: 'object',
      properties: { rescan: { type: 'boolean', description: 'Force a fresh scan even if a recent one exists.' } },
    },
    handler: networkScan,
  },
  {
    name: 'get_settings',
    label: 'settings',
    description:
      "Mission Control's own configuration — health-check interval, shared-folder settings, whether external alerts / password protection / IP allowlist / service control are on. The alert webhook URL and any password are never included.",
    parameters: NO_PARAMS,
    handler: getSettings,
  },
  {
    name: 'list_containers',
    label: 'docker containers',
    description:
      'All Docker containers on this host — name, image, running state, status. Call get_container_stats with one of these names for its CPU/memory usage.',
    parameters: NO_PARAMS,
    handler: listContainers,
  },
  {
    name: 'get_container_stats',
    label: 'container stats',
    description:
      'Live CPU and memory usage for ONE named Docker container. To compare containers, call list_containers first, then this for each name.',
    parameters: {
      type: 'object',
      properties: { container: { type: 'string', description: 'An exact container name or id (from list_containers).' } },
      required: ['container'],
    },
    handler: containerStats,
  },
  {
    name: 'get_tailscale_status',
    label: 'tailscale status',
    description:
      "This host's Tailscale state and the tailnet's other nodes — who's on it, whether each is online right now, their addresses, plus any health warnings. Use for \"who's on my tailnet\", \"is my phone connected via Tailscale\".",
    parameters: NO_PARAMS,
    handler: tailscaleStatus,
  },
  {
    name: 'list_ollama_models',
    label: 'ollama models',
    description: 'The models installed in Ollama, with size and parameter count.',
    parameters: NO_PARAMS,
    handler: ollamaModels,
  },
  {
    name: 'get_loaded_models',
    label: 'loaded models',
    description: 'Which Ollama models are currently held in memory (loaded and ready), if any.',
    parameters: NO_PARAMS,
    handler: loadedModels,
  },
  {
    name: 'get_game_servers',
    label: 'game servers',
    description:
      'Every service set up as a game server (Minecraft / FiveM) with its live player count, max players, player names, and map/gametype where available. Use for "who\'s on the Minecraft server", "is anyone playing", "how full is the FiveM server".',
    parameters: NO_PARAMS,
    handler: getGameServers,
  },
  {
    name: 'get_now_playing',
    label: 'Jellyfin now playing',
    description:
      "What's playing on Jellyfin right now — title, which device, which user, playing or paused, and progress. Returns a note if Jellyfin isn't connected or nothing is playing. Use for \"what's on the TV\", \"is anyone watching something\".",
    parameters: NO_PARAMS,
    handler: nowPlaying,
  },
  {
    name: 'list_widgets',
    label: 'board widgets',
    description:
      "The tiles on the dashboard's Board view — type, title, and a one-line detail each. Use for \"what's on my board\", \"do I have a weather widget\".",
    parameters: NO_PARAMS,
    handler: listWidgets,
  },
  {
    name: 'list_snippets',
    label: 'saved snippets',
    description:
      'The saved shell snippets (Settings → Snippets) — label, command, and working directory — plus whether the snippet runner is switched on. Use for "what snippets do I have", "can you run the backup snippet" (checking it exists first).',
    parameters: NO_PARAMS,
    handler: listSnippets,
  },
];

// ---------- Action registry ----------
// Each entry: prepare(args) -> { error } | { summary, payload }, then
// execute(payload) once the user has confirmed in chat.

const ACTION_REGISTRY = [
  {
    name: 'wake_device',
    label: 'wake device',
    description:
      'Send a Wake-on-LAN magic packet to wake a sleeping device. The device must have a MAC address set on one of the services. Use for "wake the NAS", "turn on my desktop".',
    parameters: {
      type: 'object',
      properties: { device: { type: 'string', description: "The service name of the device to wake." } },
      required: ['device'],
    },
    async prepare(args) {
      const config = await loadConfig();
      const svc = await resolveService(config, args.device);
      if (!svc) return { error: `no service named "${args.device}"` };
      if (!svc.mac) return { error: `"${svc.name}" has no MAC address set, so there's nothing to wake` };
      return { summary: `Wake ${svc.name} (${svc.mac})`, payload: { mac: svc.mac, name: svc.name } };
    },
    async execute({ mac, name }) {
      await sendMagicPacket(mac);
      return { ok: true, detail: `magic packet sent to ${name}` };
    },
  },
  {
    name: 'control_service',
    label: 'service control',
    description:
      'Start, stop, or restart a service that has start/stop/restart commands or a Docker container configured. Use for "restart Jellyfin", "stop the download client".',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name or id.' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'What to do.' },
      },
      required: ['service', 'action'],
    },
    async prepare(args) {
      const config = await loadConfig();
      if (!config.security?.serviceControl?.enabled) {
        return { error: 'Service Control is off — turn it on in Settings → Security first' };
      }
      const svc = await resolveService(config, args.service);
      if (!svc) return { error: `no service named "${args.service}"` };
      if (!svc.controller) return { error: `"${svc.name}" has no start/stop/restart set up` };
      const action = ['start', 'stop', 'restart'].includes(args.action) ? args.action : null;
      if (!action) return { error: 'action must be start, stop, or restart' };
      return { summary: `${action[0].toUpperCase()}${action.slice(1)} ${svc.name}`, payload: { serviceId: svc.id, action } };
    },
    async execute({ serviceId, action }) {
      const result = await controlService(serviceId, action, { via: 'the assistant' });
      if (!result.ok) throw new Error(result.error || 'the command failed');
      return { ok: true, detail: result.output || `${action} sent` };
    },
  },
  {
    name: 'send_alert',
    label: 'send alert',
    description:
      'Send a one-off message through the configured alert webhook (Discord / Slack / …). Use for "let everyone know the server is going down for maintenance".',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to send.' } },
      required: ['message'],
    },
    async prepare(args) {
      const message = String(args.message || '').trim();
      if (!message) return { error: 'a message is required' };
      const config = await loadConfig();
      if (!config.alerts?.webhookUrl) return { error: 'no alert webhook is configured (Settings → Notifications)' };
      return {
        summary: `Send alert: "${message.length > 80 ? `${message.slice(0, 80)}…` : message}"`,
        payload: { message },
      };
    },
    async execute({ message }) {
      await sendCustomAlert(await loadConfig(), message);
      return { ok: true, detail: 'alert sent' };
    },
  },
  {
    name: 'add_service',
    label: 'add service',
    description: 'Add a new service to the dashboard by name and URL. Use when the user wants to start tracking something new.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        url: { type: 'string', description: 'An http:// or https:// URL.' },
        group: { type: 'string', description: 'Optional existing group name.' },
        icon: { type: 'string', description: 'Optional emoji.' },
      },
      required: ['name', 'url'],
    },
    async prepare(args) {
      const name = String(args.name || '').trim();
      const url = String(args.url || '').trim();
      if (!name || !url) return { error: 'name and url are both required' };
      if (!/^https?:\/\//i.test(url)) return { error: 'url must start with http:// or https://' };
      const config = await loadConfig();
      if (config.services.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        return { error: `a service named "${name}" already exists` };
      }
      let group = null;
      if (args.group) {
        const g = config.groups.find((x) => x.name.toLowerCase() === String(args.group).toLowerCase());
        group = g ? g.id : null;
      }
      return { summary: `Add service "${name}" → ${url}`, payload: { name, url, group, icon: (args.icon || '').trim() } };
    },
    async execute(fields) {
      const result = await addService(fields, { via: 'the assistant' });
      if (result.error) throw new Error(result.error);
      return { ok: true, detail: `"${result.service.name}" added` };
    },
  },
  {
    name: 'add_connection',
    label: 'add connection',
    description:
      'Link two services — "related" (organizational only) or "depends-on" (if the dependency goes offline the dependent shows as degraded). Use for "mark that Sonarr depends on the download client".',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The dependent service (for depends-on), or one side of a related link.' },
        to: { type: 'string', description: 'The dependency (for depends-on), or the other side.' },
        type: { type: 'string', enum: ['related', 'depends-on'] },
      },
      required: ['from', 'to', 'type'],
    },
    async prepare(args) {
      const config = await loadConfig();
      const from = await resolveService(config, args.from);
      const to = await resolveService(config, args.to);
      if (!from) return { error: `no service named "${args.from}"` };
      if (!to) return { error: `no service named "${args.to}"` };
      if (from.id === to.id) return { error: 'a service cannot connect to itself' };
      const type = ['related', 'depends-on'].includes(args.type) ? args.type : 'related';
      if (config.connections.some((c) => c.from === from.id && c.to === to.id)) {
        return { error: `${from.name} and ${to.name} are already connected` };
      }
      const summary =
        type === 'depends-on' ? `Link: ${from.name} depends on ${to.name}` : `Link: ${from.name} and ${to.name} (related)`;
      return { summary, payload: { from: from.id, to: to.id, type } };
    },
    async execute(payload) {
      const result = await addConnection(payload, { via: 'the assistant' });
      if (result.error) throw new Error(result.error);
      return { ok: true, detail: 'connection added' };
    },
  },
  {
    name: 'generate_image',
    label: 'generate image',
    description:
      'Generate an image with ComfyUI and post it into the chat. Use when someone asks for a picture, artwork, an icon, a mockup, concept art, etc. One image per call.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A plain description of the image to generate.' },
        negative_prompt: { type: 'string', description: 'What to avoid (optional).' },
        width: { type: 'number', description: 'Width in pixels (optional; defaults from Settings).' },
        height: { type: 'number', description: 'Height in pixels (optional; defaults from Settings).' },
        seed: { type: 'number', description: 'Fix the seed for a reproducible result (optional).' },
      },
      required: ['prompt'],
    },
    async prepare(args) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { error: 'describe the image in "prompt"' };
      const config = await loadConfig();
      if (!config.comfy?.enabled) return { error: 'image generation is turned off (Settings → ComfyUI)' };
      try {
        buildWorkflow(config.comfy, { prompt });
      } catch (e) {
        return { error: e.message };
      }
      return {
        summary: `Generate image: "${prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt}"`,
        payload: {
          prompt,
          negative: typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined,
          width: args.width || undefined,
          height: args.height || undefined,
          seed: Number.isFinite(+args.seed) ? Math.round(+args.seed) : undefined,
        },
      };
    },
    // decideAction (ollamaActions.js) passes onProgress so the card can show
    // "sampling 12/20…", and posts result.chatMessage into the channel.
    async execute(payload, { onProgress } = {}) {
      const config = await loadConfig();
      const { images, meta } = await comfyGenerate(config.comfy, payload, { onProgress });
      if (!images.length) throw new Error('ComfyUI returned no image');

      await ensureUploadDir();
      const filename = `${nodeCrypto.randomUUID()}.png`;
      await fsp.writeFile(nodePath.join(UPLOAD_DIR, filename), images[0].buffer);

      const cleanName = payload.prompt.replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'image';
      return {
        detail: `image generated (${meta.width}×${meta.height}, seed ${images[0].seed})`,
        chatMessage: {
          author: config.ollama?.botName || 'Ollama',
          bot: true,
          text: '',
          attachment: {
            filename,
            originalName: `${cleanName}.png`,
            mimeType: 'image/png',
            size: images[0].buffer.length,
          },
        },
      };
    },
  },
  // ---------- Ops roadmap Phase 3b ----------
  {
    name: 'run_snippet',
    label: 'run snippet',
    description:
      'Run one of the saved shell snippets (Settings → Snippets) on the host and report its output. Use for "run the backup snippet", "run disk usage". Check list_snippets first if unsure of the exact name.',
    parameters: {
      type: 'object',
      properties: { snippet: { type: 'string', description: "The snippet's label (or id)." } },
      required: ['snippet'],
    },
    async prepare(args) {
      const config = await loadConfig();
      if (!config.security?.snippetRunner?.enabled) {
        return { error: 'the snippet runner is off — turn it on in Settings → Snippets first' };
      }
      const q = String(args.snippet || '').trim().toLowerCase();
      if (!q) return { error: 'which snippet? give its label' };
      const list = config.snippets || [];
      const snip =
        list.find((s) => s.id.toLowerCase() === q || s.label.toLowerCase() === q) ||
        list.find((s) => s.label.toLowerCase().includes(q));
      if (!snip) return { error: `no saved snippet matching "${args.snippet}"` };
      const cmd = snip.command.length > 70 ? `${snip.command.slice(0, 70)}…` : snip.command;
      return { summary: `Run snippet "${snip.label}" — ${cmd}`, payload: { id: snip.id, label: snip.label } };
    },
    async execute({ id, label }) {
      const config = await loadConfig();
      const snip = (config.snippets || []).find((s) => s.id === id);
      if (!snip) throw new Error(`snippet "${label}" is no longer saved`);
      const r = await runSnippet(config, snip);
      const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
      const status = r.timedOut ? 'timed out' : `exited ${r.exitCode} in ${r.ms}ms`;
      const tail = out ? ` — ${out.length > 500 ? `…${out.slice(-500)}` : out}` : '';
      return { ok: r.exitCode === 0 && !r.timedOut, detail: `${status}${tail}` };
    },
  },
  {
    name: 'game_command',
    label: 'game command',
    description:
      'Run a console command on a Minecraft server over RCON and return the reply. Use for "say hello on the minecraft server", "set the time to day", "whitelist add alice". FiveM is read-only (its console is in txAdmin).',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'The game service name (optional if there is only one).' },
        command: { type: 'string', description: 'The console command, without a leading slash.' },
      },
      required: ['command'],
    },
    async prepare(args) {
      const config = await loadConfig();
      if (!config.security?.serviceControl?.enabled) {
        return { error: 'Service Control is off — turn it on in Settings → Security to run game commands' };
      }
      const command = String(args.command || '').trim().replace(/^\//, '');
      if (!command) return { error: 'what command should I run?' };
      const games = config.services.filter((s) => s.game?.kind);
      if (!games.length) return { error: 'no game servers are set up' };
      let svc;
      const server = optionalArg(args.server);
      if (server) {
        svc = await resolveService(config, server);
        if (!svc || !svc.game?.kind) return { error: `no game server named "${server}"` };
      } else if (games.length === 1) {
        svc = games[0];
      } else {
        return { error: `which server? ${games.map((g) => g.name).join(', ')}` };
      }
      if (svc.game.kind !== 'minecraft') {
        return { error: `"${svc.name}" is a ${svc.game.kind} server — its console lives in txAdmin, Mission Control shows it read-only` };
      }
      return { summary: `Run on ${svc.name}: ${command}`, payload: { serviceId: svc.id, command } };
    },
    async execute({ serviceId, command }) {
      const config = await loadConfig();
      const svc = config.services.find((s) => s.id === serviceId);
      if (!svc?.game?.kind) throw new Error('that game server is gone');
      const reply = (await runGameCommand(svc.game, command)).trim();
      return { ok: true, detail: reply ? (reply.length > 500 ? `${reply.slice(0, 500)}…` : reply) : '(no reply)' };
    },
  },
  {
    name: 'jellyfin_control',
    label: 'Jellyfin control',
    description:
      'Play, pause, stop, or skip on a Jellyfin session. Use for "pause the TV", "resume playback", "skip to the next episode". Call get_now_playing first if you don\'t know which device.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['play', 'pause', 'playpause', 'stop', 'next', 'previous'] },
        device: { type: 'string', description: 'Which device/session (optional if only one is playing).' },
      },
      required: ['command'],
    },
    async prepare(args) {
      const config = await loadConfig();
      if (!jellyfinConfigured(config)) return { error: 'Jellyfin is not connected (Settings → Jellyfin)' };
      const map = { play: 'Unpause', pause: 'Pause', playpause: 'PlayPause', stop: 'Stop', next: 'NextTrack', previous: 'PreviousTrack' };
      const cmd = map[String(args.command || '').toLowerCase()];
      if (!cmd) return { error: 'command must be play, pause, playpause, stop, next, or previous' };
      let sessions;
      try {
        sessions = await getNowPlaying(config);
      } catch (err) {
        return { error: `couldn't reach Jellyfin: ${err.message}` };
      }
      if (!sessions.length) return { error: 'nothing is playing on Jellyfin right now' };
      let target;
      const device = optionalArg(args.device);
      if (device) {
        const q = device.toLowerCase();
        target = sessions.find((s) => s.deviceName.toLowerCase().includes(q));
        if (!target) {
          return { error: `no active session on a device matching "${device}" — playing on: ${sessions.map((s) => s.deviceName).join(', ')}` };
        }
      } else if (sessions.length === 1) {
        target = sessions[0];
      } else {
        return { error: `which device? ${sessions.map((s) => `${s.deviceName} (${s.title})`).join(', ')}` };
      }
      return {
        summary: `Jellyfin: ${args.command} on ${target.deviceName} (${target.title})`,
        payload: { sessionId: target.sessionId, command: cmd, device: target.deviceName },
      };
    },
    async execute({ sessionId, command, device }) {
      await jellyfinCommand(await loadConfig(), sessionId, command);
      return { ok: true, detail: `sent ${command} to ${device}` };
    },
  },
  {
    name: 'add_widget',
    label: 'add widget',
    description:
      'Add a tile to the dashboard Board. Supports note, links, clock, countdown, iframe, host-stats, and jellyfin widgets. Use for "add a clock for Tokyo to my board", "put a countdown to New Year on the board".',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['note', 'links', 'clock', 'countdown', 'iframe', 'host-stats', 'jellyfin'] },
        title: { type: 'string', description: 'Optional tile title.' },
        size: { type: 'string', enum: ['sm', 'md', 'lg'] },
        markdown: { type: 'string', description: 'note: the Markdown body.' },
        links: {
          type: 'array',
          description: 'links: a list of { label, url }.',
          items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } } },
        },
        timezone: { type: 'string', description: 'clock: an IANA zone like "Asia/Tokyo" (blank = device local time).' },
        target: { type: 'string', description: 'countdown: the date/time to count to (ISO 8601).' },
        label: { type: 'string', description: 'countdown: a short label for the target.' },
        url: { type: 'string', description: 'iframe: the page URL (http:// or https://).' },
      },
      required: ['type'],
    },
    async prepare(args) {
      const ALLOWED = new Set(['note', 'links', 'clock', 'countdown', 'iframe', 'host-stats', 'jellyfin']);
      if (!ALLOWED.has(args.type)) {
        return {
          error: `I can add note / links / clock / countdown / iframe / host-stats / jellyfin widgets — a "${args.type}" needs the Board's "Add a widget" button`,
        };
      }
      const body = { type: args.type, title: args.title, size: args.size };
      if (args.type === 'note') body.markdown = args.markdown || '';
      if (args.type === 'links') body.links = Array.isArray(args.links) ? args.links : [];
      if (args.type === 'clock') body.timezone = args.timezone || '';
      if (args.type === 'countdown') { body.target = args.target || ''; body.label = args.label || ''; }
      if (args.type === 'iframe') body.url = args.url || '';
      const { widget, error } = sanitizeWidget(body);
      if (error) return { error };
      const bits = [widget.type, widget.title && `"${widget.title}"`].filter(Boolean).join(' ');
      return { summary: `Add ${bits} widget to the board`, payload: { body } };
    },
    async execute({ body }) {
      const { widget, error } = await addWidget(body, { via: 'the assistant' });
      if (error) throw new Error(error);
      return { ok: true, detail: `${widget.type} widget added to the board` };
    },
  },
];

const READ_BY_NAME = new Map(READ_REGISTRY.map((t) => [t.name, t]));
const ACTION_BY_NAME = new Map(ACTION_REGISTRY.map((t) => [t.name, t]));

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toDefinition(t) {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters || NO_PARAMS },
  };
}

// The tool list handed to the model. Action tools are only included when
// config.ollama.actions is on, and generate_image only when ComfyUI is
// configured on top of that — a model that can't see a tool can't call it.
export function getToolDefinitions({ includeActions = false, comfyEnabled = false } = {}) {
  let actions = includeActions ? ACTION_REGISTRY : [];
  if (!comfyEnabled) actions = actions.filter((t) => t.name !== 'generate_image');
  return [...READ_REGISTRY, ...actions].map(toDefinition);
}

// Human-readable name for the "checked ..." footnote and the activity log.
export function toolLabel(name) {
  return (READ_BY_NAME.get(name) || ACTION_BY_NAME.get(name))?.label || name;
}

export function isActionTool(name) {
  return ACTION_BY_NAME.has(name);
}

// Every tool name — for recovering a tool call a small model emitted as
// plain text (see ollamaChat.js).
export function allToolNames() {
  return new Set([...READ_BY_NAME.keys(), ...ACTION_BY_NAME.keys()]);
}

export function getActionTool(name) {
  return ACTION_BY_NAME.get(name) || null;
}

export async function executeTool(name, rawArgs) {
  const args = parseArgs(rawArgs);
  console.log(`[ollama] tool call: ${name}`, JSON.stringify(args));
  const tool = READ_BY_NAME.get(name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.handler(args);
  } catch (err) {
    return { error: err.message };
  }
}

export { parseArgs };
