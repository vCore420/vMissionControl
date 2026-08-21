// Server-side persistence for the Timesheets tab — a fortnightly hours
// tracker that used to live entirely in one device's IndexedDB. Same
// cache + serialized-write-queue pattern as config.js, backed by its own
// file rather than folded into config.json — entries change on every
// keystroke and accumulate period after period, which isn't what a
// *configuration* file is for. See public/js/timesheet.js for the client
// side of this (day-row UI, canvas image rendering, and a small local
// IndexedDB cache of generated images — not of entries, which live here
// as the one source of truth).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, 'data', 'timesheet.json');
export const IMAGE_DIR = path.join(__dirname, 'data', 'timesheets');

let cache = null;
let writeQueue = Promise.resolve();

function pad(n) {
  return String(n).padStart(2, '0');
}
function toISO(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
function parseISO(str) {
  const parts = str.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}

function defaultProfile() {
  return { name: '', defaultStart: '08:00', defaultFinish: '16:30', defaultLunch: 30 };
}

function freshPeriod(periodStartISO) {
  return {
    periodStart: periodStartISO,
    weeks: [
      { showSat: false, showSun: false },
      { showSat: false, showSun: false },
    ],
    entries: {},
    completed: false,
    imageFilename: null,
  };
}

async function readFromDisk() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    const periodStart = toISO(getMonday(new Date()));
    return {
      profile: defaultProfile(),
      currentPeriodStart: periodStart,
      periods: { [periodStart]: freshPeriod(periodStart) },
    };
  }
}

async function write(data) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  writeQueue = writeQueue.then(() => fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8'));
  await writeQueue;
}

// Ported directly from the standalone tool: walk the stored period start
// forward or back in 14-day steps until today falls inside it. Preserves
// whatever Monday-parity Vi's pay cycle is anchored to rather than
// assuming every fortnight starts from a fixed epoch.
function computeCurrentPeriodStart(lastStartISO, today) {
  let start = parseISO(lastStartISO);
  const todayMid = stripTime(today);
  let guard = 0;
  while (addDays(start, 13) < todayMid && guard < 520) {
    start = addDays(start, 14);
    guard++;
  }
  guard = 0;
  while (start > todayMid && guard < 520) {
    start = addDays(start, -14);
    guard++;
  }
  return toISO(start);
}

// Same idea as config.js's migrate-on-load: figure out whether today's
// date means the stored "current" fortnight should have advanced, and if
// so create the next period record. Centralized here (run on every load,
// not on a client-side timer) so two devices opening the tab around the
// same rollover moment can't race each other into creating two different
// "next" periods. The outgoing period is marked completed but its image
// is *not* generated here — Node has no Canvas without a native
// dependency, so whichever client next has the tab open renders and
// uploads it (see POST /api/timesheet/periods/:periodStart/image).
async function applyRollover(data) {
  const newStart = computeCurrentPeriodStart(data.currentPeriodStart, new Date());
  if (newStart === data.currentPeriodStart) return data;

  const outgoing = data.periods[data.currentPeriodStart];
  if (outgoing) outgoing.completed = true;
  if (!data.periods[newStart]) data.periods[newStart] = freshPeriod(newStart);
  data.currentPeriodStart = newStart;
  await write(data);
  return data;
}

export async function loadTimesheet() {
  if (!cache) cache = await readFromDisk();
  cache = await applyRollover(cache);
  return cache;
}

export async function saveProfile(fields) {
  const data = await loadTimesheet();
  data.profile = { ...data.profile, ...fields };
  await write(data);
  appEvents.emit('timesheet:update', data);
  return data;
}

// A deliberate, explicit action (mirrors the standalone tool's own
// "Current fortnight starts" date field) — separate from the lazy
// rollover above, which only ever moves forward/back along the existing
// anchor's own cadence rather than jumping to an arbitrary period.
export async function switchPeriod(periodStartISO) {
  const data = await loadTimesheet();
  if (!data.periods[periodStartISO]) data.periods[periodStartISO] = freshPeriod(periodStartISO);
  data.currentPeriodStart = periodStartISO;
  await write(data);
  appEvents.emit('timesheet:update', data);
  return data;
}

export async function saveCurrentEntries({ weeks, entries }) {
  const data = await loadTimesheet();
  const period = data.periods[data.currentPeriodStart];
  if (weeks) period.weeks = weeks;
  if (entries) period.entries = entries;
  await write(data);
  appEvents.emit('timesheet:update', data);
  return data;
}

export async function resetCurrentPeriod() {
  const data = await loadTimesheet();
  data.periods[data.currentPeriodStart] = freshPeriod(data.currentPeriodStart);
  await write(data);
  appEvents.emit('timesheet:update', data);
  return data;
}

export async function listPastPeriods() {
  const data = await loadTimesheet();
  return Object.values(data.periods)
    .filter((p) => p.periodStart !== data.currentPeriodStart)
    .sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
}

export async function getPeriod(periodStartISO) {
  const data = await loadTimesheet();
  return data.periods[periodStartISO] || null;
}

export async function setPeriodImage(periodStartISO, filename) {
  const data = await loadTimesheet();
  if (!data.periods[periodStartISO]) return null;
  data.periods[periodStartISO].imageFilename = filename;
  await write(data);
  appEvents.emit('timesheet:update', data);
  return data.periods[periodStartISO];
}
