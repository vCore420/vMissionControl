// A plain, human-readable audit trail of what happened and who (which IP)
// did it — every add/change/remove across services, groups, connections,
// chat channels, settings, and config transfers; every service going
// online/offline; every new device seen; every auth event (logins,
// failures, rate-limit hits); every shared-folder file change; every
// discovery scan. Printed to the console as it happens and appended to a
// dated file under server/data/logs/ so it survives a restart. This is
// separate from devices.js (a live "who's connected" view) and from the
// health/chat/status caches (deliberately ephemeral) — this is the one
// thing in the app meant to accumulate as a history.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'data', 'logs');
const MAX_LOG_DAYS = 30;

function logFilePath(date) {
  return path.join(LOG_DIR, `${date.toISOString().slice(0, 10)}.log`);
}

function formatLine(category, message, ip) {
  const ts = new Date().toISOString();
  const ipPart = ip ? ` (${ip})` : '';
  return `[${ts}] [${category}] ${message}${ipPart}`;
}

// Fire-and-forget on purpose — logging must never slow down or fail the
// action it's describing. The console line is synchronous and always
// happens; the file write is best-effort.
export function logActivity(category, message, ip = null) {
  const line = formatLine(category, message, ip);
  console.log(line);
  fsp
    .mkdir(LOG_DIR, { recursive: true })
    .then(() => fsp.appendFile(logFilePath(new Date()), line + '\n', 'utf-8'))
    .catch((err) => console.error('[activityLog] failed to write log file:', err.message));
}

// Runs once at startup — a personal LAN dashboard's log folder shouldn't
// grow forever, but 30 days is generous enough that nothing here is trying
// to be a serious retention policy.
export async function pruneOldLogs() {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const files = await fsp.readdir(LOG_DIR);
    const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
      const fileDate = new Date(`${file.slice(0, 10)}T00:00:00Z`).getTime();
      if (fileDate < cutoff) await fsp.unlink(path.join(LOG_DIR, file)).catch(() => {});
    }
  } catch {
    // best-effort — a failed prune shouldn't block startup
  }
}
