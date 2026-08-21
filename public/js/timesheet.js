// Timesheets — a fortnightly hours tracker, adapted from a standalone tool
// (E:\projects\timesheet.html) that used to keep everything in one
// browser's IndexedDB. Here the server (server/timesheet.js) is the one
// source of truth for the profile and the live period's entries, so every
// device sees the same current fortnight; this module just renders it and
// pushes edits back, debounced the same way the standalone tool debounced
// its own IndexedDB writes. IndexedDB still has a job — see the cache
// section below — just a smaller one than before.
//
// Rollover (advancing to the next fortnight) is decided server-side, lazily,
// on every GET /api/timesheet. Node has no Canvas without a native
// dependency, so image generation stays client-side: whichever device
// happens to be open right after a rollover renders and uploads the
// just-ended period's snapshot automatically (see syncFromState below).

import { api } from './api.js';
import { state, el, toast } from './core.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
// Each leave type maps to an existing design token instead of a hardcoded
// hex, the way the standalone tool had one — so the day-row colors (and the
// generated PNG) re-skin with every Mission Control theme, including a
// custom one, rather than carrying a fixed palette into a dark theme.
const TYPES = {
  work: { label: 'Work', varName: '--accent' },
  annual: { label: 'Annual Leave', varName: '--checking' },
  sick: { label: 'Sick Leave', varName: '--offline' },
  holiday: { label: 'Public Holiday', varName: '--online' },
  other: { label: 'Other', varName: '--unmonitored' },
};

// ---------- date helpers (ported from the standalone tool) ----------

function pad(n) { return String(n).padStart(2, '0'); }
function toISO(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
function parseISO(str) {
  const parts = str.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function fmtDateShort(date) {
  const dowIndex = (date.getDay() + 6) % 7;
  return `${DAY_NAMES[dowIndex]} ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}
function fmtDateLong(date) {
  return `${date.getDate()} ${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;
}
function weekDayIndices(week) {
  const days = [0, 1, 2, 3, 4];
  if (week.showSat) days.push(5);
  if (week.showSun) days.push(6);
  return days;
}
function roundedCurrentTime() {
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const rounded = (((Math.round(totalMin / 15) * 15) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(rounded / 60))}:${pad(rounded % 60)}`;
}
function timeToMin(t) {
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}
// Entries still store/compare 24-hour "HH:MM" (calcHours needs it sortable
// and arithmetic-safe) — this only ever formats it for something a person
// reads: a <select>'s option labels and the generated PNG. Vi asked for the
// whole system to only ever show 12-hour time, and a native <input
// type="time"> can't guarantee that (its displayed format follows the
// device's OS locale, not anything this app controls) — a <select> whose
// option *text* we write ourselves sidesteps that entirely.
function formatTime12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad(m)} ${ampm}`;
}
// One shared <option> list (5-minute steps, matching the granularity the
// clock-in/out buttons and the Default Lunch field already use) reused by
// every start/finish control — the 14 day-row pairs and the two Settings
// defaults — so there's exactly one place that generates them.
const TIME_OPTIONS = (() => {
  let html = '';
  for (let totalMin = 0; totalMin < 1440; totalMin += 5) {
    const hhmm = `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}`;
    html += `<option value="${hhmm}">${formatTime12(hhmm)}</option>`;
  }
  return html;
})();
// Assigning a value a <select> has no matching <option> for (only possible
// here for an old entry saved before this change, off the 5-minute grid)
// silently resets it to the first option instead of throwing — this snaps
// to the nearest option so the field still shows something close instead
// of quietly jumping to 12:00 AM.
function setTimeSelectValue(select, hhmm) {
  select.value = hhmm;
  if (select.value === hhmm) return;
  const [h, m] = hhmm.split(':').map(Number);
  const rounded = (Math.round((h * 60 + m) / 5) * 5) % 1440;
  select.value = `${pad(Math.floor(rounded / 60))}:${pad(rounded % 60)}`;
}
function normalizeWeeks(weeks) {
  if (!weeks || weeks.length !== 2) return [{ showSat: false, showSun: false }, { showSat: false, showSun: false }];
  return weeks.map((w) => (w ? { showSat: !!w.showSat, showSun: !!w.showSun } : { showSat: false, showSun: false }));
}

// ---------- local editable snapshot ----------
// `ts` mirrors what applyStateToDOM()/the event handlers read and write —
// rebuilt from state.timesheetProfile/state.timesheetPeriod (core.js,
// updated by the initial fetch and by the 'timesheet' WS broadcast) each
// time a render actually applies. Kept as its own object rather than
// reading state.timesheet* directly everywhere because renderTimesheetImage
// needs a plain {name, defaultStart, ..., weeks, entries} shape, and this
// is also what a background-arriving WS update must NOT stomp mid-edit.
let ts = null;
let built = false;
let periodsCache = [];
let profileSaveTimer = null;
let entriesSaveTimer = null;
// Which day rows are expanded on mobile (desktop always shows every row in
// full — see the collapse rules scoped inside style.css's mobile media
// query). null until the first applyStateToDOM() call, which seeds it with
// just today's row so a phone lands on a short, scannable list instead of
// 14 open forms; every toggle after that is the user's own choice and
// survives re-renders until the period itself changes (syncFromState resets
// it — a row key is only meaningful within the period it was built for).
let expandedRows = null;

function getEntryFrom(s, w, d) {
  const key = `${w}-${d}`;
  if (!s.entries[key]) s.entries[key] = { type: 'work', start: null, finish: null, lunch: null, note: '' };
  return s.entries[key];
}
function getEntry(w, d) { return getEntryFrom(ts, w, d); }

function calcHoursFor(s, entry) {
  let start, finish, lunch;
  if (entry.type === 'work') {
    start = timeToMin(entry.start !== null ? entry.start : s.defaultStart);
    finish = timeToMin(entry.finish !== null ? entry.finish : s.defaultFinish);
    lunch = entry.lunch !== null ? entry.lunch : s.defaultLunch;
  } else {
    start = timeToMin(s.defaultStart);
    finish = timeToMin(s.defaultFinish);
    lunch = s.defaultLunch;
  }
  const mins = Math.max(0, finish - start - lunch);
  return mins / 60;
}
function calcHours(entry) { return calcHoursFor(ts, entry); }

// ---------- IndexedDB — a local cache of generated PNGs, not of entries ----------
// Entries live server-side now (see the header comment); this only saves a
// network round-trip when re-opening History. "Cleanup" here means pruning
// cached images for periods the server no longer lists — age-based
// retention (the standalone tool's own RETENTION_DAYS) doesn't apply
// anymore since the server keeps every period indefinitely by design
// ("timesheets generated can be saved server side so they are never lost").

const DB_NAME = 'MissionControlTimesheetCache';
const DB_VERSION = 1;
const STORE_NAME = 'images';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB not supported')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function cacheImage(periodStart, dataUrl) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(dataUrl, periodStart);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort cache — the server copy is the one that matters
  }
}

async function getCachedImage(periodStart) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(periodStart);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function pruneImageCache(knownPeriodStarts) {
  try {
    const db = await openDB();
    const keys = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const known = new Set(knownPeriodStarts);
    const stale = keys.filter((k) => !known.has(k));
    if (!stale.length) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    stale.forEach((k) => tx.objectStore(STORE_NAME).delete(k));
  } catch {
    // best-effort — a stale cache entry just means one extra fetch later
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- building rows ----------

function buildDayRow(w, d) {
  return `
    <div class="ts-day-row" data-week="${w}" data-day="${d}">
      <div class="ts-day-row-top" role="button" tabindex="0" aria-expanded="true" data-role="row-toggle">
        <div class="ts-day-date">
          <span class="ts-day-name">${DAY_NAMES[d]}</span>
          <span class="ts-day-date-num" data-role="date-label"></span>
          <span class="ts-today-badge hidden" data-role="today-badge">Today</span>
        </div>
        <span class="ts-row-summary-hours" data-role="summary-hours"></span>
        <select class="ts-type-select" data-field="type" aria-label="${DAY_NAMES[d]} entry type">
          <option value="work">Work</option>
          <option value="annual">Annual Leave</option>
          <option value="sick">Sick Leave</option>
          <option value="holiday">Public Holiday</option>
          <option value="other">Other</option>
        </select>
        <span class="ts-row-chevron" data-role="chevron" aria-hidden="true">⌄</span>
      </div>
      <div class="ts-day-row-fields" data-role="row-fields">
        <div class="ts-time-fields" data-role="time-fields">
          <label>Start
            <div class="ts-time-input-group">
              <select data-field="start">${TIME_OPTIONS}</select>
              <button type="button" class="ts-clock-btn hidden" data-role="clock-in">Clock in</button>
            </div>
          </label>
          <label>Finish
            <div class="ts-time-input-group">
              <select data-field="finish">${TIME_OPTIONS}</select>
              <button type="button" class="ts-clock-btn hidden" data-role="clock-out">Clock out</button>
            </div>
          </label>
          <label>Lunch (min)<input type="number" min="0" step="5" data-field="lunch"></label>
        </div>
        <span class="ts-full-day-label hidden" data-role="full-day">Full day</span>
        <input type="text" class="ts-leave-note hidden" data-role="leave-note" data-field="note" placeholder="Note (optional)">
        <div class="ts-hours-badge" data-role="hours">0.00 hrs</div>
      </div>
    </div>`;
}

function buildWeekRows() {
  [0, 1].forEach((w) => {
    const list = document.querySelector(`.ts-day-list[data-week="${w}"]`);
    let html = '';
    for (let d = 0; d < 7; d++) html += buildDayRow(w, d);
    list.innerHTML = html;
  });
}

function updateRowVisibility(row, type) {
  const timeFields = row.querySelector('[data-role="time-fields"]');
  const fullDay = row.querySelector('[data-role="full-day"]');
  const leaveNote = row.querySelector('[data-role="leave-note"]');
  if (type === 'work') {
    timeFields.classList.remove('hidden');
    fullDay.classList.add('hidden');
    leaveNote.classList.add('hidden');
  } else {
    timeFields.classList.add('hidden');
    fullDay.classList.toggle('hidden', type === 'other');
    leaveNote.classList.toggle('hidden', type !== 'other');
  }
}

function updateRowHours(row, entry) {
  const text = `${calcHours(entry).toFixed(2)} hrs`;
  row.querySelector('[data-role="hours"]').textContent = text;
  // Mirrored into the row's collapsed-state summary (mobile only — see
  // style.css) so a collapsed day row still shows something besides its
  // date without needing to be expanded first.
  row.querySelector('[data-role="summary-hours"]').textContent = text;
}

function applyStateToDOM() {
  el('tsInputName').value = ts.name || '';
  el('tsInputPeriodStart').value = ts.periodStart;
  setTimeSelectValue(el('tsInputDefaultStart'), ts.defaultStart);
  setTimeSelectValue(el('tsInputDefaultFinish'), ts.defaultFinish);
  el('tsInputDefaultLunch').value = ts.defaultLunch;

  const monday0 = parseISO(ts.periodStart);
  const todayISO = toISO(new Date());
  const isFirstApply = expandedRows === null;
  if (isFirstApply) expandedRows = new Set();

  [0, 1].forEach((w) => {
    const week = ts.weeks[w];
    const weekCard = document.querySelector(`.ts-week-card[data-week-index="${w}"]`);
    const monday = addDays(monday0, w * 7);
    const days = weekDayIndices(week);
    const lastDayIndex = days[days.length - 1];

    weekCard.querySelector('[data-role="week-dates"]').textContent =
      `${fmtDateShort(monday)} – ${fmtDateShort(addDays(monday, lastDayIndex))}`;
    weekCard.querySelector('[data-role="day-toggle"][data-day="5"]').checked = week.showSat;
    weekCard.querySelector('[data-role="day-toggle"][data-day="6"]').checked = week.showSun;

    for (let d = 0; d < 7; d++) {
      const row = weekCard.querySelector(`.ts-day-row[data-day="${d}"]`);
      const date = addDays(monday, d);
      const dateISO = toISO(date);
      const isToday = dateISO === todayISO;
      const rowKey = `${w}-${d}`;
      if (isFirstApply && isToday) expandedRows.add(rowKey);
      const isExpanded = expandedRows.has(rowKey);

      row.querySelector('[data-role="date-label"]').textContent = `${pad(date.getDate())} ${MONTHS_SHORT[date.getMonth()]}`;
      row.querySelector('[data-role="today-badge"]').classList.toggle('hidden', !isToday);
      row.classList.toggle('ts-is-today', isToday);
      row.classList.toggle('hidden', (d === 5 && !week.showSat) || (d === 6 && !week.showSun));
      row.classList.toggle('ts-expanded', isExpanded);
      row.querySelector('[data-role="row-toggle"]').setAttribute('aria-expanded', String(isExpanded));

      const entry = getEntry(w, d);
      row.dataset.type = entry.type;
      row.querySelector('[data-field="type"]').value = entry.type;
      setTimeSelectValue(row.querySelector('[data-field="start"]'), entry.start !== null ? entry.start : ts.defaultStart);
      setTimeSelectValue(row.querySelector('[data-field="finish"]'), entry.finish !== null ? entry.finish : ts.defaultFinish);
      row.querySelector('[data-field="lunch"]').value = entry.lunch !== null ? entry.lunch : ts.defaultLunch;
      row.querySelector('[data-field="note"]').value = entry.note || '';
      row.querySelector('[data-role="clock-in"]').classList.toggle('hidden', !isToday);
      row.querySelector('[data-role="clock-out"]').classList.toggle('hidden', !isToday);

      updateRowVisibility(row, entry.type);
      updateRowHours(row, entry);
    }
  });

  updateTotals();
}

function updateTotals() {
  let periodWorked = 0;
  let periodLeave = 0;
  const leaveCounts = { annual: 0, sick: 0, holiday: 0, other: 0 };

  [0, 1].forEach((w) => {
    const week = ts.weeks[w];
    const days = weekDayIndices(week);
    let weekTotal = 0;
    days.forEach((d) => {
      const entry = getEntry(w, d);
      const hrs = calcHours(entry);
      weekTotal += hrs;
      if (entry.type === 'work') {
        periodWorked += hrs;
      } else {
        periodLeave += hrs;
        leaveCounts[entry.type] = (leaveCounts[entry.type] || 0) + 1;
      }
    });
    const weekCard = document.querySelector(`.ts-week-card[data-week-index="${w}"]`);
    weekCard.querySelector('[data-role="week-total"]').textContent = `Week ${w + 1} total: ${weekTotal.toFixed(2)} hrs`;
  });

  const total = periodWorked + periodLeave;
  document.querySelector('[data-role="stamp-total"]').textContent = total.toFixed(2);
  document.querySelector('[data-role="worked-hours"]').textContent = periodWorked.toFixed(2);
  document.querySelector('[data-role="leave-hours"]').textContent = periodLeave.toFixed(2);
  document.querySelector('[data-role="total-hours"]').textContent = total.toFixed(2);

  const parts = Object.keys(TYPES)
    .filter((k) => k !== 'work' && leaveCounts[k] > 0)
    .map((k) => `${TYPES[k].label}: ${leaveCounts[k]} day${leaveCounts[k] > 1 ? 's' : ''}`);
  document.querySelector('[data-role="leave-breakdown"]').textContent =
    parts.length ? parts.join(' · ') : 'No leave recorded this period.';
}

// ---------- events ----------

function onDayFieldChange(e) {
  const field = e.target.dataset.field;
  if (!field) return;
  const row = e.target.closest('.ts-day-row');
  const w = Number(row.dataset.week);
  const d = Number(row.dataset.day);
  const entry = getEntry(w, d);

  if (field === 'type') {
    entry.type = e.target.value;
    updateRowVisibility(row, entry.type);
  } else if (field === 'start') {
    entry.start = e.target.value || null;
  } else if (field === 'finish') {
    entry.finish = e.target.value || null;
  } else if (field === 'lunch') {
    entry.lunch = e.target.value === '' ? null : Number(e.target.value);
  } else if (field === 'note') {
    entry.note = e.target.value;
  }

  row.dataset.type = entry.type;
  updateRowHours(row, entry);
  updateTotals();
  scheduleSaveEntries();
}

function onDayButtonClick(e) {
  const btn = e.target.closest('button[data-role="clock-in"], button[data-role="clock-out"]');
  if (!btn) return;
  const row = btn.closest('.ts-day-row');
  const w = Number(row.dataset.week);
  const d = Number(row.dataset.day);
  const entry = getEntry(w, d);
  const timeStr = roundedCurrentTime();

  if (btn.dataset.role === 'clock-in') {
    entry.start = timeStr;
    row.querySelector('[data-field="start"]').value = timeStr;
  } else {
    entry.finish = timeStr;
    row.querySelector('[data-field="finish"]').value = timeStr;
  }

  updateRowHours(row, entry);
  updateTotals();
  scheduleSaveEntries();
}

// Collapse/expand only has a visible effect on mobile (style.css scopes
// the hiding rules to that media query) — harmless to wire up
// unconditionally rather than checking viewport width here, since on
// desktop toggling the class just does nothing.
function toggleRowExpanded(row) {
  const key = `${row.dataset.week}-${row.dataset.day}`;
  const expanded = !expandedRows.has(key);
  if (expanded) expandedRows.add(key);
  else expandedRows.delete(key);
  row.classList.toggle('ts-expanded', expanded);
  row.querySelector('[data-role="row-toggle"]').setAttribute('aria-expanded', String(expanded));
}

function onRowToggleClick(e) {
  const toggle = e.target.closest('[data-role="row-toggle"]');
  if (!toggle || e.target.closest('select')) return;
  toggleRowExpanded(toggle.closest('.ts-day-row'));
}

function onRowToggleKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const toggle = e.target.closest('[data-role="row-toggle"]');
  if (!toggle || e.target.closest('select')) return;
  e.preventDefault();
  toggleRowExpanded(toggle.closest('.ts-day-row'));
}

function bindDayListEvents() {
  document.querySelectorAll('.ts-day-list').forEach((list) => {
    list.addEventListener('input', onDayFieldChange);
    list.addEventListener('change', onDayFieldChange);
    list.addEventListener('click', onDayButtonClick);
    list.addEventListener('click', onRowToggleClick);
    list.addEventListener('keydown', onRowToggleKeydown);
  });
}

function scheduleSaveProfile() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(async () => {
    try {
      const data = await api.saveTimesheetProfile({
        name: ts.name, defaultStart: ts.defaultStart, defaultFinish: ts.defaultFinish, defaultLunch: ts.defaultLunch,
      });
      state.timesheetProfile = data.profile;
    } catch (err) {
      toast(err.message, true);
    }
  }, 500);
}

function scheduleSaveEntries() {
  clearTimeout(entriesSaveTimer);
  entriesSaveTimer = setTimeout(async () => {
    try {
      const data = await api.saveTimesheetEntries({ weeks: ts.weeks, entries: ts.entries });
      state.timesheetPeriod = data.period;
    } catch (err) {
      toast(err.message, true);
    }
  }, 500);
}

function showExportPreview(dataUrl, periodStart) {
  el('tsExportImage').src = dataUrl;
  el('tsExportDownload').href = dataUrl;
  el('tsExportDownload').download = `timesheet-${periodStart}.png`;
  const preview = document.querySelector('[data-role="export-preview"]');
  preview.classList.remove('hidden');
  preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Mobile-only accordion (see style.css) — collapsed by default so a phone
// lands on the week view instead of a settings form; on desktop the toggle
// button is invisible and the body is always shown, same as before this
// existed. Nothing to gate by viewport here for the same reason
// toggleRowExpanded doesn't: the class only does anything where the CSS
// says it should.
function bindSettingsToggle() {
  const card = document.querySelector('[data-role="settings-card"]');
  const toggle = document.querySelector('[data-role="settings-toggle"]');
  toggle.addEventListener('click', () => {
    const expanded = card.classList.toggle('ts-open');
    toggle.setAttribute('aria-expanded', String(expanded));
  });
}

function bindSettingsEvents() {
  el('tsInputName').addEventListener('input', (e) => {
    ts.name = e.target.value;
    scheduleSaveProfile();
  });

  el('tsInputPeriodStart').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    const newStart = toISO(getMonday(parseISO(e.target.value)));
    if (newStart === ts.periodStart) {
      e.target.value = ts.periodStart;
      return;
    }
    try {
      const data = await api.switchTimesheetPeriod(newStart);
      state.timesheetPeriod = data.period;
      syncFromState();
      applyStateToDOM();
      document.querySelector('[data-role="export-preview"]').classList.add('hidden');
      await refreshHistory();
    } catch (err) {
      toast(err.message, true);
      e.target.value = ts.periodStart;
    }
  });

  el('tsInputDefaultStart').addEventListener('change', (e) => {
    ts.defaultStart = e.target.value || ts.defaultStart;
    applyStateToDOM();
    scheduleSaveProfile();
  });
  el('tsInputDefaultFinish').addEventListener('change', (e) => {
    ts.defaultFinish = e.target.value || ts.defaultFinish;
    applyStateToDOM();
    scheduleSaveProfile();
  });
  el('tsInputDefaultLunch').addEventListener('change', (e) => {
    ts.defaultLunch = e.target.value === '' ? 0 : Number(e.target.value);
    applyStateToDOM();
    scheduleSaveProfile();
  });

  document.querySelectorAll('[data-role="day-toggle"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const w = Number(e.target.dataset.week);
      const d = Number(e.target.dataset.day);
      if (d === 5) ts.weeks[w].showSat = e.target.checked;
      else if (d === 6) ts.weeks[w].showSun = e.target.checked;
      applyStateToDOM();
      scheduleSaveEntries();
    });
  });

  el('tsResetBtn').addEventListener('click', async () => {
    if (!confirm('Clear all entries for the current fortnight? This cannot be undone.')) return;
    try {
      const data = await api.resetTimesheetPeriod();
      state.timesheetPeriod = data.period;
      syncFromState();
      applyStateToDOM();
      document.querySelector('[data-role="export-preview"]').classList.add('hidden');
    } catch (err) {
      toast(err.message, true);
    }
  });

  el('tsGenerateBtn').addEventListener('click', async () => {
    const dataUrl = renderTimesheetImage(ts);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await api.uploadTimesheetImage(ts.periodStart, blob);
      await cacheImage(ts.periodStart, dataUrl);
      showExportPreview(dataUrl, ts.periodStart);
      toast('Timesheet image saved');
      await refreshHistory();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function bindHistoryEvents() {
  document.querySelector('[data-role="history-list"]').addEventListener('click', async (e) => {
    const btn = e.target.closest('.ts-history-view-btn');
    if (!btn || btn.disabled) return;
    const periodStart = btn.dataset.period;
    let dataUrl = await getCachedImage(periodStart);
    if (!dataUrl) {
      try {
        const res = await fetch(api.timesheetImageUrl(periodStart));
        if (!res.ok) throw new Error('image not available');
        dataUrl = await blobToDataUrl(await res.blob());
        await cacheImage(periodStart, dataUrl);
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    showExportPreview(dataUrl, periodStart);
  });
}

async function refreshHistory() {
  try {
    const res = await api.listTimesheetPeriods();
    periodsCache = res.periods;
  } catch {
    // keep the last known list rather than blanking it on a transient error
  }

  const card = document.querySelector('[data-role="history-card"]');
  const list = document.querySelector('[data-role="history-list"]');

  if (!periodsCache.length) {
    card.classList.add('hidden');
    list.innerHTML = '';
  } else {
    card.classList.remove('hidden');
    list.innerHTML = periodsCache.map((p) => {
      const start = parseISO(p.periodStart);
      const end = addDays(start, 13);
      return `<div class="ts-history-item">
        <span class="ts-history-dates">${fmtDateShort(start)} – ${fmtDateShort(end)}</span>
        <button type="button" class="btn ghost ts-history-view-btn" data-period="${p.periodStart}"${p.hasImage ? '' : ' disabled'}>${p.hasImage ? 'View image' : 'No image saved'}</button>
      </div>`;
    }).join('');
  }

  pruneImageCache([ts.periodStart, ...periodsCache.map((p) => p.periodStart)]);
}

// ---------- image export ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000';
}

function renderTimesheetImage(s) {
  // Bumped 15% over the original standalone tool's sizing, per Vi's ask
  // for easier-to-read exports. Every geometry constant and font size below
  // scales off this one factor so row spacing grows in step with the text
  // instead of the two drifting apart into overlap.
  const S = 1.15;
  const fpx = (n) => Math.round(n * S);

  const monday0 = parseISO(s.periodStart);
  const weeksData = s.weeks.map((week, w) => {
    const days = weekDayIndices(week);
    const monday = addDays(monday0, w * 7);
    const rows = days.map((d) => {
      const entry = getEntryFrom(s, w, d);
      return { d, date: addDays(monday, d), entry, hours: calcHoursFor(s, entry) };
    });
    return { w, startDate: monday, endDate: addDays(monday, days[days.length - 1]), rows };
  });

  const rowH = 34 * S, weekHeaderH = 32 * S, colHeaderH = 26 * S, weekTotalH = 30 * S, weekGap = 26 * S;
  const topH = 150 * S, summaryH = 90 * S, footerH = 40 * S, bottomBuffer = 40 * S;
  const width = 900 * S;
  let height = topH;
  weeksData.forEach((wd) => {
    height += weekHeaderH + colHeaderH + wd.rows.length * rowH + weekTotalH + weekGap;
  });
  height += summaryH + footerH + bottomBuffer;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const paper = cssVar('--bg-elevated');
  const ink = cssVar('--text');
  const inkMuted = cssVar('--text-dim');
  const inkFaint = cssVar('--text-faint');
  const accent = cssVar('--accent');
  const rule = cssVar('--border');

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(64 * S, 24 * S);
  ctx.lineTo(64 * S, height - 24 * S);
  ctx.stroke();

  const leftX = 92 * S;
  let y = 44 * S;

  ctx.fillStyle = ink;
  ctx.font = `700 ${fpx(26)}px Georgia, "Times New Roman", serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('TIMESHEET', leftX, y);

  let totalHrs = 0;
  weeksData.forEach((wd) => wd.rows.forEach((r) => { totalHrs += r.hours; }));

  ctx.save();
  ctx.translate(width - 150 * S, 40 * S);
  ctx.rotate((-4 * Math.PI) / 180);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(-70 * S, -24 * S, 140 * S, 48 * S);
  ctx.fillStyle = accent;
  ctx.font = `700 ${fpx(20)}px "Cascadia Code", "Consolas", monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(`${totalHrs.toFixed(2)} HRS`, 0, -2 * S);
  ctx.font = `600 ${fpx(10)}px Arial, sans-serif`;
  ctx.fillText('THIS PERIOD', 0, 14 * S);
  ctx.restore();

  ctx.textAlign = 'left';
  y += 26 * S;
  ctx.font = `${fpx(16)}px Arial, sans-serif`;
  ctx.fillStyle = inkMuted;
  if (s.name && s.name.trim()) {
    ctx.fillText(s.name.trim(), leftX, y);
    y += 22 * S;
  }
  const periodEndDate = addDays(monday0, 13);
  ctx.fillText(`${fmtDateLong(monday0)} – ${fmtDateLong(periodEndDate)}`, leftX, y);
  y += 34 * S;

  // start/finish get more room than the original layout gave them — "8:00
  // AM" style labels (formatTime12 below) run longer than a bare "08:00".
  const cols = {
    date: leftX, day: leftX + 120 * S, type: leftX + 180 * S,
    start: leftX + 345 * S, finish: leftX + 460 * S, lunch: leftX + 560 * S, hours: width - 100 * S,
  };

  weeksData.forEach((wd) => {
    ctx.fillStyle = ink;
    ctx.font = `700 ${fpx(17)}px Georgia, serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`Week ${wd.w + 1}`, leftX, y);
    ctx.font = `${fpx(14)}px Arial, sans-serif`;
    ctx.fillStyle = inkMuted;
    ctx.fillText(`${fmtDateShort(wd.startDate)} – ${fmtDateShort(wd.endDate)}`, leftX + 95 * S, y);
    y += weekHeaderH;

    ctx.font = `700 ${fpx(11)}px Arial, sans-serif`;
    ctx.fillStyle = inkFaint;
    ctx.textAlign = 'left';
    ctx.fillText('DATE', cols.date, y);
    ctx.fillText('DAY', cols.day, y);
    ctx.fillText('TYPE', cols.type, y);
    ctx.fillText('START', cols.start, y);
    ctx.fillText('FINISH', cols.finish, y);
    ctx.fillText('LUNCH', cols.lunch, y);
    ctx.textAlign = 'right';
    ctx.fillText('HOURS', cols.hours, y);
    ctx.textAlign = 'left';
    y += colHeaderH;

    wd.rows.forEach((r) => {
      ctx.strokeStyle = rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftX - 12 * S, y + 8 * S);
      ctx.lineTo(width - 64 * S, y + 8 * S);
      ctx.stroke();

      ctx.fillStyle = ink;
      ctx.font = `${fpx(13)}px "Cascadia Code", "Consolas", monospace`;
      ctx.fillText(`${pad(r.date.getDate())} ${MONTHS_SHORT[r.date.getMonth()]}`, cols.date, y);

      ctx.font = `${fpx(13)}px Arial, sans-serif`;
      ctx.fillText(DAY_NAMES[r.d], cols.day, y);

      const typeInfo = TYPES[r.entry.type];
      ctx.fillStyle = cssVar(typeInfo.varName);
      ctx.beginPath();
      ctx.arc(cols.type - 10 * S, y - 4 * S, 4 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.fillText(typeInfo.label, cols.type, y);

      ctx.font = `${fpx(13)}px "Cascadia Code", "Consolas", monospace`;
      if (r.entry.type === 'work') {
        ctx.fillStyle = ink;
        ctx.fillText(formatTime12(r.entry.start !== null ? r.entry.start : s.defaultStart), cols.start, y);
        ctx.fillText(formatTime12(r.entry.finish !== null ? r.entry.finish : s.defaultFinish), cols.finish, y);
        const lunchVal = r.entry.lunch !== null ? r.entry.lunch : s.defaultLunch;
        ctx.fillText(`${lunchVal}m`, cols.lunch, y);
      } else {
        ctx.fillStyle = inkFaint;
        ctx.fillText('—', cols.start, y);
        ctx.fillText('—', cols.finish, y);
        ctx.fillText('—', cols.lunch, y);
      }

      ctx.fillStyle = ink;
      ctx.textAlign = 'right';
      ctx.fillText(r.hours.toFixed(2), cols.hours, y);
      ctx.textAlign = 'left';

      y += rowH;
    });

    let weekTotal = 0;
    wd.rows.forEach((r) => { weekTotal += r.hours; });
    ctx.font = `700 ${fpx(14)}px Arial, sans-serif`;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.fillText(`Week ${wd.w + 1} total: ${weekTotal.toFixed(2)} hrs`, width - 64 * S, y + 14 * S);
    ctx.textAlign = 'left';
    y += weekTotalH + weekGap;
  });

  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(leftX - 12 * S, y);
  ctx.lineTo(width - 64 * S, y);
  ctx.stroke();
  y += 30 * S;

  let workedH = 0;
  weeksData.forEach((wd) => wd.rows.forEach((r) => { if (r.entry.type === 'work') workedH += r.hours; }));
  const leaveH = totalHrs - workedH;

  ctx.font = `700 ${fpx(15)}px Arial, sans-serif`;
  ctx.fillStyle = ink;
  ctx.fillText(`Hours worked: ${workedH.toFixed(2)}    Leave hours: ${leaveH.toFixed(2)}    Total: ${totalHrs.toFixed(2)}`, leftX, y);
  y += 26 * S;

  const counts = {};
  weeksData.forEach((wd) => wd.rows.forEach((r) => {
    if (r.entry.type !== 'work') counts[r.entry.type] = (counts[r.entry.type] || 0) + 1;
  }));
  const parts = Object.keys(counts).map((k) => `${TYPES[k].label}: ${counts[k]} day${counts[k] > 1 ? 's' : ''}`);
  ctx.font = `${fpx(13)}px Arial, sans-serif`;
  ctx.fillStyle = inkMuted;
  ctx.fillText(parts.length ? parts.join('   ·   ') : 'No leave taken this period.', leftX, y);
  y += footerH - 10 * S;

  ctx.font = `${fpx(11)}px Arial, sans-serif`;
  ctx.fillStyle = inkFaint;
  ctx.fillText(`Generated ${fmtDateLong(new Date())}`, leftX, y);

  return canvas.toDataURL('image/png');
}

// ---------- sync + entry point ----------

function syncFromState() {
  const profile = state.timesheetProfile;
  const period = state.timesheetPeriod;
  const previous = ts;

  ts = {
    name: profile.name,
    defaultStart: profile.defaultStart,
    defaultFinish: profile.defaultFinish,
    defaultLunch: profile.defaultLunch,
    periodStart: period.periodStart,
    weeks: normalizeWeeks(period.weeks),
    entries: period.entries || {},
  };

  if (previous && previous.periodStart !== ts.periodStart) {
    archiveOutgoingPeriod(previous);
    // Row keys ("0-2" etc.) are only meaningful within the period they were
    // built for — carrying them into a new period would expand/collapse
    // the wrong days by coincidence of matching week/day indices. Re-seeded
    // fresh (today, if it falls in the new period) on the next apply.
    expandedRows = null;
  }
}

async function archiveOutgoingPeriod(previousTs) {
  try {
    const dataUrl = renderTimesheetImage(previousTs);
    const blob = await (await fetch(dataUrl)).blob();
    await api.uploadTimesheetImage(previousTs.periodStart, blob);
    await cacheImage(previousTs.periodStart, dataUrl);
  } catch {
    // best-effort background archive — a failure here just leaves that one
    // period without a saved snapshot; nothing else about the app breaks
  }
}

export async function renderTimesheet({ forceFetch = false } = {}) {
  if (!built) {
    el('tsInputDefaultStart').innerHTML = TIME_OPTIONS;
    el('tsInputDefaultFinish').innerHTML = TIME_OPTIONS;
    buildWeekRows();
    bindDayListEvents();
    bindSettingsToggle();
    bindSettingsEvents();
    bindHistoryEvents();
    built = true;
  }

  // Don't yank an active edit's focus/value out from under a keystroke —
  // the same guard handleWsConfig uses for an in-progress drag (core.js).
  // The underlying state is already current (core.js updated it before
  // calling in); this render just waits for a blur/tab-switch/poll.
  if (document.activeElement && el('timesheetView').contains(document.activeElement)) return;

  if (forceFetch || !state.timesheetProfile) {
    try {
      const data = await api.getTimesheet();
      state.timesheetProfile = data.profile;
      state.timesheetPeriod = data.period;
    } catch (err) {
      toast(err.message, true);
      return;
    }
  }

  syncFromState();
  applyStateToDOM();
  await refreshHistory();
}

// A rollover can happen while this tab is in the background — catch up the
// moment it's looked at again, same trigger the standalone tool used.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && el('timesheetView').classList.contains('active')) {
    renderTimesheet({ forceFetch: true });
  }
});
