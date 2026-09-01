import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from '../config.js';
import { writeJsonAtomic } from '../jsonStore.js';
import { checkNow, forgetService } from '../healthChecker.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const configTransferRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 5;

// A password's salt/hash never belongs in a file meant to be copied
// around, backed up, or handed to another machine — auth is this
// install's own, not part of the portable "setup".
function withoutAuth(config) {
  const { auth, ...rest } = config;
  return rest;
}

// The whole point of export/import is "everything persisted", so this is
// otherwise deliberately just config.json's own shape — no curation
// needed, since chat history, device tracking, and host stats were never
// in config.json to begin with (all ephemeral/in-memory, documented as
// such elsewhere).
configTransferRouter.get('/export', async (req, res) => {
  const config = await loadConfig();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="mission-control-config-${date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(withoutAuth(config), null, 2));
  logActivity('config', 'Exported config', clientIp(req));
});

// A snapshot of whatever's about to be overwritten, written to disk before
// any wholesale replace touches it — this is what a mis-clicked or
// mistakenly-tested import can be recovered from without anyone having to
// reconstruct data from memory. Server-side only, never downloaded, so
// (unlike /export) it's fine for this to include the real auth hash.
async function writeBackup(config) {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUPS_DIR, `config-${stamp}.json`);
  await writeJsonAtomic(file, config);

  const entries = (await fs.readdir(BACKUPS_DIR)).filter((f) => f.endsWith('.json')).sort();
  const excess = entries.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) {
    await fs.unlink(path.join(BACKUPS_DIR, entries[i])).catch(() => {});
  }
}

// Wholesale replace, not a merge — a merge would need conflict rules for
// every duplicate id/name across services, groups, connections, and chat
// channels, which is a lot of ambiguous judgment calls for a feature meant
// to answer "restore this backup" / "move to a new machine". The frontend
// gets a hard confirm() before this is ever called since it discards
// whatever's currently configured, and writeBackup() above means this
// isn't the only copy either way.
configTransferRouter.post('/import', async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'not a valid config file' });
  }
  if (!Array.isArray(incoming.services) || !Array.isArray(incoming.groups)) {
    return res.status(400).json({ error: 'missing services or groups — this doesn\'t look like a Mission Control export' });
  }

  const previous = await loadConfig();
  await writeBackup(previous);

  const previousIds = new Set(previous.services.map((s) => s.id));
  const incomingIds = new Set(incoming.services.map((s) => s.id));

  const next = {
    // Merged from the file — except trustProxy, which decides whether
    // X-Forwarded-For is believed (net.js) and so stays tied to this install
    // the same way auth/security do below.
    settings: { ...previous.settings, ...incoming.settings, trustProxy: previous.settings.trustProxy },
    sharedFolder: incoming.sharedFolder ?? previous.sharedFolder,
    alerts: incoming.alerts ?? previous.alerts,
    groups: incoming.groups,
    services: incoming.services,
    connections: Array.isArray(incoming.connections) ? incoming.connections : previous.connections,
    chatChannels: Array.isArray(incoming.chatChannels) && incoming.chatChannels.length
      ? incoming.chatChannels
      : previous.chatChannels,
    // Never taken from the imported file, under any circumstance. auth and
    // security protect this install directly. ollama, code and comfy carry
    // host-local, security-sensitive settings — the Ollama/ComfyUI endpoint
    // URLs, the assistant's action tools, the Code agent's workspace path and
    // its shell-command switch — that a stale or malicious file must not be
    // able to set. Keeping them from `previous` (rather than just omitting
    // them) also stops migrate() from silently resetting them to defaults on
    // the next load.
    auth: previous.auth,
    security: previous.security,
    ollama: previous.ollama,
    code: previous.code,
    comfy: previous.comfy,
  };

  // Whichever branch connections came from, drop any that point at a
  // service the new roster doesn't have — a service swap (or a partial
  // hand-edited import) can otherwise leave dangling from/to ids around.
  const finalServiceIds = new Set(next.services.map((s) => s.id));
  next.connections = next.connections.filter((c) => finalServiceIds.has(c.from) && finalServiceIds.has(c.to));

  await saveConfig(next);
  for (const id of previousIds) {
    if (!incomingIds.has(id)) forgetService(id);
  }
  logActivity('config', `Imported config (${next.services.length} services)`, clientIp(req));
  checkNow(loadConfig).catch(() => {});

  res.json({ ok: true, serviceCount: next.services.length });
});
