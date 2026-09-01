// Scheduled tasks (ops roadmap Phase 4) — a 60-second tick that runs the due
// entries in `config.schedules`. Each entry is
//   { id, label, when, action, enabled, lastRun, lastResult }
// where `when` is a short human string (see parseWhen) and `action` is one of:
//   { type: 'snippet',  snippetId }              — runs a saved snippet
//   { type: 'command',  serviceId, command }     — an RCON command on a game server
//   { type: 'restart',  serviceId }              — restarts a service
//
// Nothing here is a new privilege: every action goes through the exact same
// gate its manual equivalent uses — the snippet runner switch for 'snippet',
// Service Control for 'command'/'restart' — checked at fire time, so a task
// whose feature is switched off is logged as skipped, not run. Editing the
// list (routes/schedules.js) only needs the normal session, like editing
// snippets; a task can't actually do anything until the relevant switch (and
// the password it requires) is on.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { runSnippet } from './snippets.js';
import { runGameCommand } from './gameServers.js';
import { controlService } from './serviceControl.js';
import { logActivity, readRecentActivity } from './activityLog.js';
import { planZip, streamPlannedZip, ZipTooLargeError } from './zip.js';
import { generateWallpaper, isArtGenerating, withArtLock, ArtGenError } from './artGen.js';
import { addWallpaper } from './wallpaperStore.js';
import { sendCustomAlert } from './alerts.js';

const TICK_MS = 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 'every 5m' is the floor — no per-minute config churn
const MAX_SCHEDULES = 30;
const MAX_LABEL = 60;
const MAX_COMMAND = 400;

let timer = null;
let ticking = false;

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

// ---------- `when` parsing ----------

// Returns a spec object or { error }. Accepted forms (case-insensitive):
//   every 30m | every 2 hours
//   daily at 03:00
//   weekly on monday at 09:30
export function parseWhen(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { error: 'a schedule is required' };

  let m = s.match(/^every (\d+) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (m) {
    const n = Number(m[1]);
    const unitMs = /^h/.test(m[2]) ? 3600e3 : 60e3;
    const ms = n * unitMs;
    if (ms < MIN_INTERVAL_MS) return { error: 'the shortest interval is every 5 minutes' };
    if (ms > 7 * 24 * 3600e3) return { error: "that's longer than a week — use 'weekly on …' instead" };
    return { kind: 'interval', ms };
  }

  m = s.match(/^daily at (\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return { error: 'that time is out of range (00:00–23:59)' };
    return { kind: 'daily', hh, mm };
  }

  m = s.match(/^weekly on ([a-z]+) at (\d{1,2}):(\d{2})$/);
  if (m) {
    const dow = DAYS.indexOf(m[1]) !== -1 ? DAYS.indexOf(m[1]) : DAY_ALIASES[m[1]];
    if (dow === undefined) return { error: `"${m[1]}" isn't a day of the week` };
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    if (hh > 23 || mm > 59) return { error: 'that time is out of range (00:00–23:59)' };
    return { kind: 'weekly', dow, hh, mm };
  }

  return {
    error: "couldn't read that — use \"every 30m\", \"every 2 hours\", \"daily at 03:00\", or \"weekly on monday at 09:30\"",
  };
}

// A tidy restatement for the UI (also confirms the parse worked).
export function describeWhen(raw) {
  const spec = parseWhen(raw);
  if (spec.error) return spec.error;
  const at = (h, mn) => `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
  if (spec.kind === 'interval') {
    return spec.ms % 3600e3 === 0 ? `every ${spec.ms / 3600e3}h` : `every ${spec.ms / 60e3}m`;
  }
  if (spec.kind === 'daily') return `daily at ${at(spec.hh, spec.mm)}`;
  return `weekly on ${DAYS[spec.dow]} at ${at(spec.hh, spec.mm)}`;
}

// Whether a task is due *now*, given when it last ran. `now` is a Date.
function isDue(spec, lastRunIso, now = new Date()) {
  const last = lastRunIso ? Date.parse(lastRunIso) : null;

  if (spec.kind === 'interval') {
    return !last || now.getTime() - last >= spec.ms;
  }

  // daily / weekly: today's target instant, in the host's local time.
  const target = new Date(now);
  target.setHours(spec.hh, spec.mm, 0, 0);

  if (spec.kind === 'weekly' && now.getDay() !== spec.dow) return false;
  if (now < target) return false;
  // Fire once after the target passes — not again until the target has moved
  // on (next day / next week), which `last < target` captures.
  return !last || last < target.getTime();
}

// ---------- validation ----------

const clampStr = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const clampInt = (v, lo, hi, fb) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

let seq = 0;
const newId = () => `sched-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// Returns { schedules } (sanitized, keeps lastRun/lastResult from `existing`
// by id) or { error }.
export function sanitizeSchedules(list, existing = []) {
  if (!Array.isArray(list)) return { error: 'schedules must be a list' };
  const prev = new Map(existing.map((s) => [s.id, s]));
  const out = [];
  for (const raw of list.slice(0, MAX_SCHEDULES)) {
    const label = clampStr(raw?.label, MAX_LABEL);
    if (!label) continue; // a labelless row is a half-filled form — drop it
    const when = clampStr(raw?.when, 40);
    const w = parseWhen(when);
    if (w.error) return { error: `"${label}": ${w.error}` };

    const a = raw?.action || {};
    let action;
    if (a.type === 'snippet') {
      const snippetId = clampStr(a.snippetId, 60);
      if (!snippetId) return { error: `"${label}": pick a snippet` };
      action = { type: 'snippet', snippetId };
    } else if (a.type === 'command') {
      const serviceId = clampStr(a.serviceId, 80);
      const command = clampStr(a.command, MAX_COMMAND);
      if (!serviceId || !command) return { error: `"${label}": a command task needs a game server and a command` };
      action = { type: 'command', serviceId, command };
    } else if (a.type === 'restart') {
      const serviceId = clampStr(a.serviceId, 80);
      if (!serviceId) return { error: `"${label}": pick a service to restart` };
      action = { type: 'restart', serviceId };
    } else if (a.type === 'backup') {
      const sourcePath = clampStr(a.sourcePath, 400);
      const destPath = clampStr(a.destPath, 400);
      if (!sourcePath || !destPath) return { error: `"${label}": a backup task needs a source folder and a destination folder` };
      if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destPath)) {
        return { error: `"${label}": both folder paths must be absolute` };
      }
      const kept = clampInt(a.keep, 1, 100, 7);
      action = { type: 'backup', sourcePath, destPath, keep: kept };
    } else if (a.type === 'wallpaper') {
      action = { type: 'wallpaper', themeId: clampStr(a.themeId, 40), extraPrompt: clampStr(a.extraPrompt, 400) };
    } else if (a.type === 'digest') {
      action = { type: 'digest', hours: clampInt(a.hours, 1, 720, 24) };
    } else {
      return { error: `"${label}": unknown action type` };
    }

    const id = /^sched-[a-z0-9-]{1,40}$/.test(raw?.id) ? raw.id : newId();
    const keep = prev.get(id);
    out.push({
      id,
      label,
      when,
      action,
      enabled: raw?.enabled !== undefined ? !!raw.enabled : true,
      lastRun: keep?.lastRun || null,
      lastResult: keep?.lastResult || null,
    });
  }
  return { schedules: out };
}

// ---------- running an action ----------

// Never throws. Returns { ok, detail } — a short line stored as lastResult
// and written to the activity log.
async function runAction(config, schedule) {
  const { action } = schedule;

  if (action.type === 'snippet') {
    if (!config.security?.snippetRunner?.enabled || !config.auth?.enabled) {
      return { ok: false, detail: 'skipped — the snippet runner is off' };
    }
    const snip = (config.snippets || []).find((s) => s.id === action.snippetId);
    if (!snip) return { ok: false, detail: 'skipped — that snippet no longer exists' };
    const r = await runSnippet(config, snip);
    const status = r.timedOut ? 'timed out' : `exit ${r.exitCode}`;
    return { ok: r.exitCode === 0 && !r.timedOut, detail: `snippet "${snip.label}" — ${status} (${r.ms}ms)` };
  }

  if (action.type === 'command') {
    if (!config.security?.serviceControl?.enabled || !config.auth?.enabled) {
      return { ok: false, detail: 'skipped — Service Control is off' };
    }
    const svc = (config.services || []).find((s) => s.id === action.serviceId);
    if (!svc?.game?.kind) return { ok: false, detail: 'skipped — that game server no longer exists' };
    try {
      const reply = String(await runGameCommand(svc.game, action.command)).trim();
      return { ok: true, detail: `${svc.name}: ${action.command} → ${reply.slice(0, 120) || '(no reply)'}` };
    } catch (err) {
      return { ok: false, detail: `${svc.name}: ${err.message}` };
    }
  }

  if (action.type === 'restart') {
    // controlService does its own SC + auth gate check
    const svc = (config.services || []).find((s) => s.id === action.serviceId);
    if (!svc) return { ok: false, detail: 'skipped — that service no longer exists' };
    const res = await controlService(action.serviceId, 'restart', { via: 'a scheduled task' });
    return res.ok
      ? { ok: true, detail: `restarted ${svc.name}${res.output ? ` — ${String(res.output).slice(0, 100)}` : ''}` }
      : { ok: false, detail: `restart ${svc.name}: ${res.error || 'failed'}` };
  }

  if (action.type === 'backup') {
    // A backup writes a zip wherever it's pointed and runs nothing, so the
    // bar is just "a password is set" — lighter than Service Control.
    if (!config.auth?.enabled) return { ok: false, detail: 'skipped — set a password to enable folder backups' };
    return runBackup(action);
  }

  if (action.type === 'wallpaper') {
    if (isArtGenerating()) return { ok: false, detail: 'skipped — another image is generating' };
    try {
      const wp = await withArtLock(async () => {
        const r = await generateWallpaper({ themeId: action.themeId, extraPrompt: action.extraPrompt });
        return addWallpaper({ themeId: action.themeId, prompt: r.prompt, seed: r.seed, width: r.width, height: r.height }, r.buffer);
      });
      return { ok: true, detail: `generated a wallpaper${action.themeId ? ` (${action.themeId})` : ''} — ${wp.id}` };
    } catch (err) {
      return { ok: false, detail: err instanceof ArtGenError ? `skipped — ${err.message}` : `wallpaper failed: ${err.message}` };
    }
  }

  if (action.type === 'digest') {
    if (!config.alerts?.webhookUrl) return { ok: false, detail: 'skipped — no alert webhook is configured' };
    try {
      const { text, count } = await buildDigest(action.hours);
      await sendCustomAlert(config, text);
      return { ok: true, detail: `sent digest — ${count} event${count === 1 ? '' : 's'} over ${action.hours}h` };
    } catch (err) {
      return { ok: false, detail: `digest failed: ${err.message}` };
    }
  }

  return { ok: false, detail: `unknown action type "${action.type}"` };
}

// ---------- backup ----------

const pad2 = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

async function runBackup({ sourcePath, destPath, keep }) {
  try {
    const sStat = await fsp.stat(sourcePath);
    if (!sStat.isDirectory()) return { ok: false, detail: `source is not a folder: ${sourcePath}` };
  } catch {
    return { ok: false, detail: `source folder not found: ${sourcePath}` };
  }
  await fsp.mkdir(destPath, { recursive: true });

  const base = path.basename(sourcePath).replace(/[^\w.-]+/g, '_') || 'backup';
  const outName = `${base}-${stamp()}.zip`;
  const outPath = path.join(destPath, outName);

  let plan;
  try {
    plan = await planZip(sourcePath, { skipDirs: new Set(['node_modules', '.git']) });
  } catch (err) {
    return { ok: false, detail: err instanceof ZipTooLargeError ? err.message : `couldn't read the source: ${err.message}` };
  }

  const stream = fs.createWriteStream(outPath);
  try {
    await streamPlannedZip(stream, plan.entries);
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    stream.destroy();
    await fsp.unlink(outPath).catch(() => {});
    return { ok: false, detail: `zip failed: ${err.message}` };
  }

  const zipStat = await fsp.stat(outPath).catch(() => null);
  const mb = zipStat ? (zipStat.size / 1024 ** 2).toFixed(1) : '?';

  // Retention: keep the newest `keep` archives for this source, drop the rest.
  let pruned = 0;
  try {
    const mine = (await fsp.readdir(destPath))
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.zip'))
      .sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - keep))) {
      await fsp.unlink(path.join(destPath, f)).catch(() => {});
      pruned += 1;
    }
  } catch {
    // a prune failure isn't a backup failure
  }

  return {
    ok: true,
    detail: `backed up ${base} → ${outName} (${mb} MB)${pruned ? `, pruned ${pruned} old` : ''}`,
  };
}

// ---------- activity digest ----------

async function buildDigest(hours) {
  const entries = await readRecentActivity({ sinceHours: hours, limit: 500 });
  if (!entries.length) {
    return { text: `Mission Control — nothing logged in the last ${hours}h.`, count: 0 };
  }
  const byCat = new Map();
  for (const e of entries) byCat.set(e.category, (byCat.get(e.category) || 0) + 1);
  const counts = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ');
  // A few of the entries that most warrant a look, newest first.
  const NOTABLE = new Set(['security', 'auth', 'schedule', 'control', 'service']);
  const highlights = entries
    .filter((e) => NOTABLE.has(e.category))
    .slice(-8)
    .reverse()
    .map((e) => `• [${e.category}] ${e.message}`);

  const lines = [
    `Mission Control — last ${hours}h: ${entries.length} events (${counts})`,
    ...(highlights.length ? ['', ...highlights] : []),
  ];
  return { text: lines.join('\n'), count: entries.length };
}

// Runs one schedule, records the outcome, persists. Shared by the tick and
// the "Run now" button. Returns { ok, detail, lastRun, lastResult }.
async function fire(schedule, { manual = false } = {}) {
  const config = await loadConfig();
  const target = (config.schedules || []).find((s) => s.id === schedule.id);
  if (!target) return { ok: false, detail: 'that schedule is gone' };
  const label = target.label;

  const result = await runAction(config, target);

  // runAction can take minutes (a wallpaper generation), during which
  // another write may have replaced the config cache — re-load and merge the
  // lastRun/lastResult onto the *current* config rather than clobbering it.
  const at = new Date().toISOString();
  const lastResult = { at, ok: result.ok, detail: result.detail };
  const fresh = await loadConfig();
  const live = (fresh.schedules || []).find((s) => s.id === schedule.id);
  if (live) {
    live.lastRun = at;
    live.lastResult = lastResult;
    await saveConfig(fresh);
  }

  logActivity('schedule', `${manual ? 'Ran' : 'Scheduled task'} "${label}" — ${result.detail}`);
  return { ...result, lastRun: at, lastResult };
}

export async function runScheduleNow(id) {
  const config = await loadConfig();
  const schedule = (config.schedules || []).find((s) => s.id === id);
  if (!schedule) return { error: 'schedule not found' };
  const r = await fire(schedule, { manual: true });
  return { result: { ok: r.ok, detail: r.detail }, lastRun: r.lastRun, lastResult: r.lastResult };
}

// ---------- the tick ----------

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const config = await loadConfig();
    const now = new Date();
    for (const schedule of config.schedules || []) {
      if (!schedule.enabled) continue;
      const spec = parseWhen(schedule.when);
      if (spec.error) continue; // a broken row just doesn't run
      if (!isDue(spec, schedule.lastRun, now)) continue;
      await fire(schedule); // fire re-loads config + persists per task
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

export function initScheduler() {
  if (timer) return;
  // A short first run so a task that was due while the server was down goes
  // out soon after boot, not up to a full tick later.
  setTimeout(tick, 5000);
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[scheduler] started (60s tick)');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
