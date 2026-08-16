import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';

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
  if (!config.alerts) {
    config.alerts = { enabled: false, webhookUrl: '', format: 'generic' };
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
  if (changed) await saveConfig(config);
  return config;
}

export async function loadConfig() {
  if (!cache) cache = await migrate(await readFromDisk());
  return cache;
}

// Serializes writes so concurrent API calls can't clobber each other. Every
// mutation in the app funnels through here, which makes this the one place
// that needs to announce "config changed" for real-time sync across every
// connected device — no individual route has to remember to broadcast.
export async function saveConfig(next) {
  cache = next;
  writeQueue = writeQueue.then(() =>
    fs.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8')
  );
  await writeQueue;
  appEvents.emit('config', cache);
  return cache;
}

// The one thing in config.json that must never reach a client: the
// password salt/hash. Used everywhere config gets sent out — GET
// /api/config and every WebSocket 'config' broadcast — so there's a single
// place this rule lives instead of every call site remembering it.
export function sanitizeConfig(config) {
  return { ...config, auth: { enabled: !!config.auth?.enabled, sessionDays: config.auth?.sessionDays ?? 30 } };
}

export function resolveSharedFolderPath(config) {
  const p = config.sharedFolder.path;
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
}
