// Polls each HTTP-checkable service on an interval and keeps an in-memory
// status cache. The frontend polls GET /api/status cheaply instead of
// triggering a network request per page load, and also gets pushed fresh
// status over the WebSocket the moment a sweep finishes — the poll stays in
// place as a fallback in case a client's socket is down. Alongside the
// current status, a capped per-service history ring buffer is kept so the
// frontend can show an uptime sparkline without needing a real time-series
// database.

import { appEvents } from './events.js';
import { checkTransitions, forgetService as forgetAlertService } from './alerts.js';
import { logActivity } from './activityLog.js';
import { checkTailscaleStatus } from './tailscale.js';
import { getGameStatus } from './gameServers.js';

const statusCache = new Map();
const historyCache = new Map(); // serviceId -> Array<{status: 'online'|'offline', t: number}>
let timer = null;
let lastSweepAt = null; // read by host.js — a sweep loop that's silently stopped ticking is exactly the kind of thing Host Health should be able to surface

// Separate from alerts.js's own transition tracker (which only runs when a
// webhook is configured) — this logs every online<->offline flip
// unconditionally, since the activity log is meant to capture that
// regardless of whether external alerts are set up.
const prevLoggedStatus = new Map();
const LOGGABLE_STATUSES = new Set(['online', 'offline']);

function logTransitions(snapshot, services) {
  const nameById = new Map(services.map((s) => [s.id, s.name]));
  for (const entry of snapshot) {
    const prev = prevLoggedStatus.get(entry.id);
    prevLoggedStatus.set(entry.id, entry.status);
    if (!LOGGABLE_STATUSES.has(prev) || !LOGGABLE_STATUSES.has(entry.status) || prev === entry.status) continue;
    const name = nameById.get(entry.id) ?? entry.id;
    logActivity('health', `"${name}" ${entry.status === 'online' ? 'came back online' : 'went offline'}`);
  }
}

const HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours of samples is plenty for a sparkline
const HISTORY_MAX_ENTRIES = 2000; // safety cap regardless of check interval
const SPARKLINE_SAMPLES = 30;

function recordHistory(serviceId, status) {
  if (status !== 'online' && status !== 'offline') return; // skip unmonitored/checking noise
  let history = historyCache.get(serviceId);
  if (!history) {
    history = [];
    historyCache.set(serviceId, history);
  }
  history.push({ status, t: Date.now() });

  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  while (history.length && (history[0].t < cutoff || history.length > HISTORY_MAX_ENTRIES)) {
    history.shift();
  }
}

// A service whose own health check passes but that depends (directly or
// transitively) on something that's confirmed offline is "degraded" —
// distinct from "offline" (its own check still passes) and from "online"
// (nothing it relies on is down). Only 'depends-on' connections feed
// this; 'related' connections are just organizational and never affect
// status. Only a dependency's raw 'offline' status counts as "down" —
// 'unmonitored'/'checking' dependencies don't cascade, since their real
// state isn't actually known. Runs after every sweep/recheck against
// whatever's currently in statusCache, so it always reflects the latest
// data for every service, not just the one(s) just checked.
function applyCascadingStatus(connections) {
  const dependsOnEdges = connections.filter((c) => c.type === 'depends-on');
  const dependencyIdsOf = new Map(); // serviceId -> [ids it depends on]
  for (const edge of dependsOnEdges) {
    if (!dependencyIdsOf.has(edge.from)) dependencyIdsOf.set(edge.from, []);
    dependencyIdsOf.get(edge.from).push(edge.to);
  }

  for (const [id, entry] of statusCache) {
    if (entry.status !== 'online') {
      entry.effectiveStatus = entry.status;
      entry.degradedBy = [];
      continue;
    }
    const downDependencies = [];
    const visited = new Set([id]);
    const stack = [...(dependencyIdsOf.get(id) || [])];
    while (stack.length) {
      const depId = stack.pop();
      if (visited.has(depId)) continue;
      visited.add(depId);
      if (statusCache.get(depId)?.status === 'offline') downDependencies.push(depId);
      stack.push(...(dependencyIdsOf.get(depId) || []));
    }
    entry.effectiveStatus = downDependencies.length ? 'degraded' : 'online';
    entry.degradedBy = downDependencies;
  }
}

function markUnmonitored(service) {
  statusCache.set(service.id, {
    id: service.id,
    status: 'unmonitored',
    latencyMs: null,
    lastChecked: null,
    error: null,
  });
}

async function checkOne(service, timeoutMs) {
  // A game server (creative roadmap Phase 5) is checked over its own
  // protocol (RCON for Minecraft), not an HTTP ping — its game port isn't a
  // web server. The player count rides the `detail` field, same mechanism as
  // the Tailscale check below. This runs whether or not `healthCheck` is on:
  // if a service has a `game` config, that IS how it's monitored.
  if (service.game?.kind) {
    const started = performance.now();
    let status = 'offline';
    let detail = null;
    let error = null;
    try {
      const r = await getGameStatus(service.game); // lightweight — no full player pull
      status = 'online';
      const n = r.count ?? 0;
      detail = `${n}${r.max != null ? `/${r.max}` : ''} player${n === 1 ? '' : 's'}`;
    } catch (err) {
      error = err.message;
    }
    statusCache.set(service.id, {
      id: service.id,
      status,
      httpStatus: null,
      latencyMs: Math.round(performance.now() - started),
      lastChecked: new Date().toISOString(),
      error,
      detail,
    });
    recordHistory(service.id, status);
    return;
  }

  if (!service.healthCheck) {
    markUnmonitored(service);
    return;
  }

  // Bypasses the URL entirely — Tailscale isn't an HTTP service worth
  // pinging, so this asks the CLI whether the tailnet connection is
  // actually up instead. `url` stays untouched as just the Enter-link.
  if (service.tailscaleHealthCheck) {
    const started = performance.now();
    const result = await checkTailscaleStatus();
    const status = result.online ? 'online' : 'offline';
    statusCache.set(service.id, {
      id: service.id,
      status,
      httpStatus: null,
      latencyMs: Math.round(performance.now() - started),
      lastChecked: new Date().toISOString(),
      error: result.online ? null : result.detail,
      detail: result.online ? result.detail : null,
    });
    recordHistory(service.id, status);
    return;
  }

  const url = service.url.replace(/\/+$/, '') + (service.healthCheckPath || '/');
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const latencyMs = Math.round(performance.now() - started);
    const status = res.ok || res.status < 500 ? 'online' : 'offline';
    statusCache.set(service.id, {
      id: service.id,
      status,
      httpStatus: res.status,
      latencyMs,
      lastChecked: new Date().toISOString(),
      error: null,
    });
    recordHistory(service.id, status);
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    statusCache.set(service.id, {
      id: service.id,
      status: 'offline',
      httpStatus: null,
      latencyMs,
      lastChecked: new Date().toISOString(),
      error: err.name === 'AbortError' ? 'timeout' : err.message,
    });
    recordHistory(service.id, 'offline');
  } finally {
    clearTimeout(timeout);
  }
}

async function runSweep(getConfig) {
  const config = await getConfig();
  const timeoutMs = config.settings.healthCheckTimeoutMs ?? 3000;
  await Promise.allSettled(config.services.map((s) => checkOne(s, timeoutMs)));
  applyCascadingStatus(config.connections);
  const snapshot = getStatusSnapshot();
  logTransitions(snapshot, config.services);
  checkTransitions(snapshot, config);
  appEvents.emit('status', snapshot);
  lastSweepAt = new Date().toISOString();
}

export function getLastSweepAt() {
  return lastSweepAt;
}

export function startHealthChecker(getConfig) {
  const tick = async () => {
    const config = await getConfig();
    await runSweep(getConfig);
    const intervalMs = config.settings.healthCheckIntervalMs ?? 15000;
    timer = setTimeout(tick, intervalMs);
  };
  tick();
}

export function stopHealthChecker() {
  if (timer) clearTimeout(timer);
}

export function getStatusSnapshot() {
  return Array.from(statusCache.values()).map((entry) => {
    const history = historyCache.get(entry.id) || [];
    const relevant = history.filter((h) => h.status === 'online' || h.status === 'offline');
    const uptimePercent = relevant.length
      ? Math.round((relevant.filter((h) => h.status === 'online').length / relevant.length) * 100)
      : null;
    return {
      ...entry,
      uptimePercent,
      history: history.slice(-SPARKLINE_SAMPLES).map((h) => h.status),
    };
  });
}

// Called after config edits so a newly added/edited service gets checked
// immediately instead of waiting for the next full sweep.
export async function checkNow(getConfig) {
  await runSweep(getConfig);
}

// Rechecks a single service on demand (e.g. a "check now" button) without
// waiting for or disturbing the regular sweep interval.
export async function checkOneService(getConfig, serviceId) {
  const config = await getConfig();
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return null;
  const timeoutMs = config.settings.healthCheckTimeoutMs ?? 3000;
  await checkOne(service, timeoutMs);
  applyCascadingStatus(config.connections);
  const snapshot = getStatusSnapshot();
  logTransitions(snapshot, config.services);
  checkTransitions(snapshot, config);
  appEvents.emit('status', snapshot);
  return snapshot.find((s) => s.id === serviceId) ?? null;
}

// Called when a service is deleted so its cached status/history don't leak
// forever in memory.
export function forgetService(serviceId) {
  statusCache.delete(serviceId);
  historyCache.delete(serviceId);
  prevLoggedStatus.delete(serviceId);
  forgetAlertService(serviceId);
}
