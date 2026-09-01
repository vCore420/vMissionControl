// A plain, human-readable audit trail of what happened and who (which IP)
// did it — every add/change/remove across services, groups, connections,
// chat channels, settings, and config transfers; every service going
// online/offline; every new device seen; every auth event (logins,
// failures, rate-limit hits); every security-relevant setting change (IP
// allowlist, service control); every shared-folder file change; every
// discovery scan; every scheduled task that fires (category 'schedule').
// Printed to the console as it happens and appended to a dated file under
// server/data/logs/ so it survives a restart. This is separate from
// devices.js (a live "who's connected" view) and from the health/chat/status
// caches (deliberately ephemeral) — this is the one thing in the app meant
// to accumulate as a history.
//
// A curated slice of this stream also goes out over the external-alerts
// webhook (see alerts.js's alertActivity, called below) — new devices and
// security changes are exactly the kind of thing worth a phone
// notification, unlike most of what else flows through here.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertActivity } from './alerts.js';
import { appEvents } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'data', 'logs');
const MAX_LOG_DAYS = 30;

function logFilePath(date) {
  return path.join(LOG_DIR, `${date.toISOString().slice(0, 10)}.log`);
}

function formatLine(ts, category, message, ip) {
  const ipPart = ip ? ` (${ip})` : '';
  return `[${ts}] [${category}] ${message}${ipPart}`;
}

// Fire-and-forget on purpose — logging must never slow down or fail the
// action it's describing. The console line is synchronous and always
// happens; the file write is best-effort. alertActivity is the same
// fire-and-forget shape — it's a no-op instantly for anything outside its
// own curated category/message allowlist (see alerts.js), so every one of
// the many call sites elsewhere in the app gets webhook-relay eligibility
// for free instead of needing to remember to wire it in individually.
export function logActivity(category, message, ip = null) {
  const time = new Date().toISOString();
  const line = formatLine(time, category, message, ip);
  console.log(line);
  // Live feed for the Activity view (creative/ops roadmap) — a leaf-module
  // event, same fire-and-forget spirit as the file write and alertActivity.
  appEvents.emit('activity', { time, category, message, ip: ip || null });
  fsp
    .mkdir(LOG_DIR, { recursive: true })
    .then(() => fsp.appendFile(logFilePath(new Date()), line + '\n', 'utf-8'))
    .catch((err) => console.error('[activityLog] failed to write log file:', err.message));
  alertActivity(category, message, ip).catch(() => {});
}

// Reads the trail back out — the one structured query over this otherwise
// write-only log. Backs both the Ollama assistant's get_activity_log tool
// ("what happened overnight?", chronological) and the Activity view
// (GET /api/activity — newest-first, searchable, paginated via `before`).
const LINE_RE = /^\[([^\]]+)\] \[([^\]]+)\] (.*?)(?: \(([^()]+)\))?$/;

// opts:
//   sinceHours  — time window (also decides how many day-files to read)
//   category    — exact category match (case-insensitive)
//   search      — case-insensitive substring on the message
//   before      — ISO timestamp; only entries strictly before it (pagination)
//   limit       — page size
//   newestFirst — default false (chronological, for the assistant tool)
export async function readRecentActivity({
  sinceHours = 24, category = null, search = null, before = null, limit = 80, newestFirst = false,
} = {}) {
  const cutoff = Date.now() - Math.max(1, sinceHours) * 3600e3;
  const beforeT = before ? Date.parse(before) : null;
  const want = category ? String(category).toLowerCase() : null;
  const needle = search ? String(search).toLowerCase() : null;

  // One file per UTC day the window touches, capped at the 31-day retention.
  const dayCount = Math.min(31, Math.max(4, Math.ceil(sinceHours / 24) + 1));
  const now = new Date();
  const dayFiles = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dayFiles.push(logFilePath(d)); // oldest first
  }

  const entries = [];
  for (const file of dayFiles) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(LINE_RE);
      if (!m) continue;
      const [, ts, cat, message, ip] = m;
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t < cutoff) continue;
      if (beforeT != null && Number.isFinite(t) && t >= beforeT) continue;
      if (want && cat.toLowerCase() !== want) continue;
      if (needle && !message.toLowerCase().includes(needle)) continue;
      entries.push({ time: ts, category: cat, message, ip: ip || null });
    }
  }

  // The parse loop already yields oldest-first (files + lines both ascending).
  return newestFirst
    ? entries.slice(-Math.max(1, limit)).reverse()
    : entries.slice(-Math.max(1, limit));
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
