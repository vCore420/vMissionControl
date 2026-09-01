import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';
import { writeJsonAtomic } from './jsonStore.js';
import { DEFAULT_DENY } from './codeCommandRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'data', 'config.example.json');

let cache = null;
let writeQueue = Promise.resolve();

// config.json holds your actual services, LAN addresses, and shared-folder
// path, so it's gitignored — config.example.json is the committed template.
// A fresh clone (or anyone deleting config.json to start over) gets it
// seeded from the example automatically instead of crashing on startup.
async function ensureConfigExists() {
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    await fs.copyFile(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
  }
}

async function readFromDisk() {
  await ensureConfigExists();
  const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

// Fields added after someone's config.json was already on disk need a
// one-time default + write-back, or an install that predates them would
// crash reading `undefined.something`. chatChannels (added alongside the
// chat feature) is the current example of that.
async function migrate(config) {
  let changed = false;
  if (!config.chatChannels) {
    config.chatChannels = [{ id: 'general', name: 'General' }];
    changed = true;
  }
  // Whether X-Forwarded-For is trusted as the client's IP. Off by default:
  // with no reverse proxy in front (the normal setup) that header is
  // attacker-controlled, and trusting it lets a client spoof its address past
  // the login rate-limiter (auth.js) and the IP allowlist (ipAllowlist.js).
  // Turn on only behind a proxy that sets it — nginx, Caddy, `tailscale
  // serve`. See net.js#clientIp.
  if (config.settings && config.settings.trustProxy === undefined) {
    config.settings.trustProxy = false;
    changed = true;
  }
  if (!config.alerts) {
    config.alerts = { enabled: false, webhookUrl: '', format: 'generic' };
    changed = true;
  }
  // Chat's optional local-LLM assistant (see README's Ollama section). Every
  // field here reaches clients verbatim — sanitizeConfig only strips auth —
  // which is fine because a local Ollama needs no credentials. If this ever
  // grows a remote endpoint with a token, that token must NOT live here.
  if (!config.ollama) {
    config.ollama = {
      baseUrl: 'http://localhost:11434',
      model: '',
      systemPrompt: '',
      botName: 'Ollama',
      botEmoji: '🦙',
      trigger: '@ollama',
      contextMessages: 30,
      keepAlive: '30m',
      numPredict: 512,
      requestTimeoutMs: 120000,
      active: false,
      tools: false,
    };
    changed = true;
  }
  // Read-only system-lookup tools for the assistant (M8) — added to an
  // ollama block that predates them.
  if (config.ollama && config.ollama.tools === undefined) {
    config.ollama.tools = false;
    changed = true;
  }
  // Action tools (wake a device, restart a service, ...) — separately
  // gated on top of `tools`, and (like service control) refused unless
  // password protection is also on. Every one still needs an explicit
  // in-chat confirmation before it runs.
  if (config.ollama && config.ollama.actions === undefined) {
    config.ollama.actions = false;
    changed = true;
  }
  // The Code tab's local coding agent (see README's Code section). Like the
  // Ollama assistant it needs no credentials — it reuses config.ollama.baseUrl
  // for the connection — so every field here reaches clients verbatim through
  // sanitizeConfig, which is fine. `enabled` is refused at the settings route
  // unless config.auth.enabled is also on (same rule as service control): the
  // agent writes files and runs commands on the host, so it sits behind the
  // password gate. `allowCommands` is an extra opt-in on top of that (like
  // serviceControl on top of auth) — the run_command tool isn't even offered
  // to the model unless it's on.
  if (!config.code) {
    config.code = {
      enabled: false,
      workspacePath: '',            // '' → resolved at runtime (see codeWorkspace.js)
      defaultModel: '',             // seeds a new session's own model
      defaultApprovalMode: 'ask',   // 'ask' | 'auto-edit' | 'auto-all'
      maxSteps: 25,                 // agent tool-loop cap
      contextTokens: 16384,         // num_ctx handed to Ollama — the real window
      compactAtPercent: 75,         // in-turn context compaction trips at this % of the window (Code parity 1b)
      disabledTools: [],            // optional tools the user switched off (Code parity 2a)
      visionModel: '',              // Ollama vision model that describes attached images for the chosen model (Code parity 4a)
      visionTimeoutMs: 240000,      // per-image describe budget — CPU/GPU-contended vision inference is slow
      contextFileName: 'AGENTS.md',  // workspace source-of-truth file, read into the prompt each turn ('' = off)
      memoryFileName: 'AGENTS-memory.md', // agent's running-notes file, read into the prompt + appended to by the agent ('' = off)
      allowCommands: false,         // run_command opt-in — a second switch on top of `enabled` (see README's Code section)
      commandRules: { allow: [], deny: [...DEFAULT_DENY] }, // per-command allow/deny globs (Code parity 2b)
      commandTimeoutMs: 60000,
      keepAlive: '30m',             // model keep-warm
      numPredict: 0,                // 0 = model default; coding wants long output
      requestTimeoutMs: 300000,     // per-turn abort — coding turns run long
    };
    changed = true;
  }
  // run_command opt-in, added to a config.code block that predates Phase 4.
  if (config.code && config.code.allowCommands === undefined) {
    config.code.allowCommands = false;
    changed = true;
  }
  // num_ctx for the coding agent — Ollama's default (~4k) is far too small
  // once a file read is in context. Added to a config.code block that
  // predates the Phase 6 context meter.
  if (config.code && config.code.contextTokens === undefined) {
    config.code.contextTokens = 16384;
    changed = true;
  }
  // In-turn context compaction (Code parity roadmap 1b) — when a long
  // agentic turn's message stack passes this % of the window, codeAgent.js
  // has the model summarise the older rounds so the turn doesn't fall apart.
  if (config.code && config.code.compactAtPercent === undefined) {
    config.code.compactAtPercent = 75;
    changed = true;
  }
  // Optional Code-agent tools the user has switched off (Code parity 2a) —
  // a lean tool list matters for a weak local model. Only the non-core tools
  // can go here; codeTools.js#getCodeToolDefinitions enforces that.
  if (config.code && config.code.disabledTools === undefined) {
    config.code.disabledTools = [];
    changed = true;
  }
  // Per-command allow/deny rules (Code parity roadmap 2b). A deny match
  // refuses run_command outright (even in auto-all); an allow match runs it
  // with no Confirm card (even in "ask"); no match defers to the session's
  // approval mode. The deny list is seeded with catastrophic / outbound
  // patterns — see codeCommandRules.js DEFAULT_DENY — and is fully editable.
  if (config.code && config.code.commandRules === undefined) {
    config.code.commandRules = { allow: [], deny: [...DEFAULT_DENY] };
    changed = true;
  }
  // The "eyes" — an Ollama vision model that describes an image attached to a
  // Code message, so the chosen coding model (which need not be multimodal)
  // can act on it (Code parity roadmap 4a). Blank = attached images just get a
  // "no vision model set" note.
  if (config.code && config.code.visionModel === undefined) {
    config.code.visionModel = '';
    changed = true;
  }
  if (config.code && config.code.visionTimeoutMs === undefined) {
    config.code.visionTimeoutMs = 240000;
    changed = true;
  }
  // Source-of-truth file (Phase 7): a CLAUDE.md/AGENTS.md-style doc in the
  // workspace the agent reads every turn. Added to a config.code block that
  // predates it — default on, blank turns it off.
  if (config.code && config.code.contextFileName === undefined) {
    config.code.contextFileName = 'AGENTS.md';
    changed = true;
  }
  // Memory file (Phase 8): the agent's own running-notes doc, read into the
  // prompt alongside the source-of-truth file and appended to by the agent.
  // Pair it with an already-customised source-of-truth name (e.g. CYN.md →
  // CYN-memory.md) so a config that predates this migration stays consistent.
  if (config.code && config.code.memoryFileName === undefined) {
    const ctx = config.code.contextFileName;
    config.code.memoryFileName =
      typeof ctx === 'string' && /^[^./\\]+\.md$/i.test(ctx.trim())
        ? ctx.trim().replace(/\.md$/i, '-memory.md')
        : 'AGENTS-memory.md';
    changed = true;
  }
  // Verification commands the agent can run with run_checks (syntax / lint /
  // tests) — user-authored, so no allowCommands gate. Added to a config.code
  // block that predates the tool.
  if (config.code && config.code.checks === undefined) {
    config.code.checks = []; // [{ label, command }]
    config.code.checkTimeoutMs = 120000;
    changed = true;
  }
  // ComfyUI image generation for the Code agent and the @cyn chat assistant
  // (see README's ComfyUI section). Reuses the same trust model as the Code
  // feature — `enabled` is refused at the settings route unless
  // config.auth.enabled is also on. The `workflow` is an API-format ComfyUI
  // graph you paste in Settings; `mapping` is which node input holds the
  // prompt/seed/size/checkpoint (auto-detected from the graph, editable). No
  // credentials here, so every field reaches clients through sanitizeConfig.
  if (!config.comfy) {
    config.comfy = {
      enabled: false,
      baseUrl: 'http://127.0.0.1:8188',
      workflow: '',                 // API-format JSON string, pasted in Settings
      mapping: {},                  // {field: {node, key}} — {} = auto-detect at build time
      model: '',                    // default checkpoint (dropdown from ComfyUI); '' = whatever the workflow bakes in
      defaultNegative: '',
      defaultWidth: 512,
      defaultHeight: 512,
      defaultSteps: 20,
      defaultCfg: 7,
      promptPrefix: '',             // prepended to the agent's prompt, e.g. "masterpiece, best quality"
      promptSuffix: '',
      timeoutMs: 300000,            // per-generation wait (CPU gen is slow — raise for big workflows)
      ejectAfterMin: 10,            // POST /free this long after the last generation (0 = never)
      maxPerTurn: 6,                // Code agent: images per turn cap
      outputDir: '',                // workspace subfolder for generated images ('' = root)
    };
    changed = true;
  }
  if (!config.auth) {
    config.auth = { enabled: false, salt: '', hash: '', sessionDays: 30 };
    changed = true;
  }
  if (config.auth.sessionDays === undefined) {
    config.auth.sessionDays = 30;
    changed = true;
  }
  if (!config.security) {
    config.security = { ipAllowlist: { enabled: false, subnets: [] } };
    changed = true;
  }
  // Service control (start/stop/restart via a per-service script hook) runs
  // commands on the host, so it gets its own opt-in switch on top of
  // everything else — off by default even if a service already has a
  // controller configured, and refused at request time (routes/services.js)
  // unless password auth is also on, per the security pass agreed before
  // this feature was built.
  if (!config.security.serviceControl) {
    config.security.serviceControl = { enabled: false };
    changed = true;
  }
  // Snippet runner (creative roadmap Phase 2) — runs a saved shell command on
  // the host, so it gets the same double gate as service control: its own
  // switch here + password auth, both checked at request time
  // (routes/snippets.js). The saved list itself is config.snippets.
  if (!config.security.snippetRunner) {
    config.security.snippetRunner = { enabled: false, timeoutMs: 60000 };
    changed = true;
  }
  if (!config.snippets) {
    config.snippets = []; // [{ id, label, command, cwd }]
    changed = true;
  }
  // Scheduled tasks (ops roadmap Phase 4) — [{ id, label, when, action,
  // enabled, lastRun, lastResult }]. server/scheduler.js validates the list
  // and runs a due task on its 60s tick; every action is still gated by the
  // same switch its manual equivalent uses (snippet runner / Service
  // Control), checked at fire time.
  if (!config.schedules) {
    config.schedules = [];
    changed = true;
  }
  // Board-view widgets (creative roadmap Phase 3; more types in ops roadmap
  // Phase 2) — tiles shown in a 4th dashboard view mode. Display config
  // only; see server/widgets.js for the type list and per-type validation.
  if (!config.widgets) {
    config.widgets = [];
    changed = true;
  }
  // Jellyfin connection (creative roadmap Phase 4) — the "now playing" widget.
  // The apiKey is a real credential: sanitizeConfig strips it before config
  // ever reaches a client (only `hasApiKey` goes out), same as auth's salt/hash.
  if (!config.jellyfin) {
    config.jellyfin = { baseUrl: '', apiKey: '' };
    changed = true;
  }
  // Connections predate the depends-on/related distinction — anything
  // without a type is what every connection used to mean: just "related",
  // undirected, no cascading-status implication.
  for (const conn of config.connections) {
    if (!conn.type) {
      conn.type = 'related';
      changed = true;
    }
  }
  if (changed) await saveConfig(config);
  return config;
}

export async function loadConfig() {
  if (!cache) cache = await migrate(await readFromDisk());
  return cache;
}

// Synchronous peek at the already-loaded config, for the rare caller that
// can't be async — net.js#clientIp runs inside synchronous Express/WebSocket
// plumbing. null only before the first loadConfig(); every request path runs
// long after startup has awaited that.
export function peekConfig() {
  return cache;
}

// Serializes writes so concurrent API calls can't clobber each other. Every
// mutation in the app funnels through here, which makes this the one place
// that needs to announce "config changed" for real-time sync across every
// connected device — no individual route has to remember to broadcast.
export async function saveConfig(next) {
  cache = next;
  writeQueue = writeQueue.then(() => writeJsonAtomic(CONFIG_PATH, next));
  await writeQueue;
  appEvents.emit('config', cache);
  return cache;
}

// The one thing in config.json that must never reach a client: the
// password salt/hash. Used everywhere config gets sent out — GET
// /api/config and every WebSocket 'config' broadcast — so there's a single
// place this rule lives instead of every call site remembering it.
export function sanitizeConfig(config) {
  return {
    ...config,
    auth: { enabled: !!config.auth?.enabled, sessionDays: config.auth?.sessionDays ?? 30 },
    // The Jellyfin API key never leaves the server — clients get the URL and
    // a "there is a key" flag, and the settings UI only sends a new key when
    // the field is actually filled in.
    jellyfin: { baseUrl: config.jellyfin?.baseUrl || '', hasApiKey: !!config.jellyfin?.apiKey },
    // Same treatment for a game server's RCON password (creative roadmap
    // Phase 5) — strip it, leave a flag.
    services: (config.services || []).map((s) =>
      s.game?.rconPassword
        ? { ...s, game: { ...s.game, rconPassword: undefined, hasRconPassword: true } }
        : s
    ),
  };
}

export function resolveSharedFolderPath(config) {
  const p = config.sharedFolder.path;
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
}
