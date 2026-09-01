// Kiosk mode (ops roadmap Phase 2c) — turns a device into a wall display:
// the Board with no header / nav / edit chrome, a big clock, and an auto-dim
// that fades the screen down after a few idle minutes (screen burn-in, and a
// dark room at night). Everything still live-updates over the WebSocket — a
// kiosk is a read-only window on the same board every other device sees.
//
// Entry is the URL: point the kiosk browser at `…/?kiosk=1` (optionally
// `&dim=<minutes>`, 0 = never dim). That's remembered in localStorage so a
// reload or a browser crash doesn't drop out of it, and the query param is
// stripped after it's read so a copied URL isn't sticky for someone else.
// Leaving: `?kiosk=0`, the Esc key, or the on-screen ✕. The Board view's
// "⛶ Kiosk mode" button is the same switch for a device you're holding.

import { state, el, setLocal } from './core.js';
import { renderCards } from './dashboard.js';

const KIOSK_KEY = 'mc:kiosk';
const DIM_KEY = 'mc:kioskDimMin';
const CONTROLS_HIDE_MS = 4000;
const DEFAULT_DIM_MIN = 5;

let dimTimer = null;
let controlsTimer = null;
let clockTimer = null;
let dimMinutes = DEFAULT_DIM_MIN;
let lastActivityArm = 0;

function clampDim(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : DEFAULT_DIM_MIN;
}

// Reads ?kiosk / ?dim, persists them, strips them from the address bar, and
// returns whether kiosk should be on (param wins; otherwise the stored flag).
function readEntry() {
  const params = new URLSearchParams(location.search);
  if (params.has('kiosk')) {
    const on = params.get('kiosk') !== '0';
    setLocal(KIOSK_KEY, on ? '1' : '');
    if (params.has('dim')) setLocal(DIM_KEY, String(clampDim(params.get('dim'))));
    params.delete('kiosk');
    params.delete('dim');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    return on;
  }
  return localStorage.getItem(KIOSK_KEY) === '1';
}

export function isKiosk() {
  return document.body.classList.contains('kiosk-mode');
}

export function enterKiosk({ persist = true, fullscreen = false } = {}) {
  if (isKiosk()) return;
  if (persist) setLocal(KIOSK_KEY, '1');
  dimMinutes = clampDim(localStorage.getItem(DIM_KEY));
  document.body.classList.add('kiosk-mode');

  // Kiosk *is* the Board — force the dashboard view and the board layout,
  // keeping the layout switch's active pill honest for when kiosk exits.
  for (const b of el('viewSwitch').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.view === 'dashboard');
  }
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  el('dashboardView').classList.add('active');
  el('toolbarDashboardControls').classList.add('hidden');
  if (state.dashboardViewMode !== 'board') {
    state.dashboardViewMode = 'board';
    setLocal('mc:dashboardView', 'board');
    for (const b of el('dashboardLayoutSwitch').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.layout === 'board');
    }
  }
  // At first paint config hasn't arrived yet — loadAll()'s render pass will
  // draw the board (dashboardViewMode is 'board' now). On a runtime toggle
  // config is already here, so render straight away.
  if (state.config) renderCards();

  startClock();
  bindActivity();
  armDim();
  showControls();
  if (fullscreen) requestFs();
}

export function exitKiosk() {
  if (!isKiosk()) return;
  setLocal(KIOSK_KEY, '');
  document.body.classList.remove('kiosk-mode', 'kiosk-dimmed', 'kiosk-controls-shown');
  clearTimeout(dimTimer);
  clearTimeout(controlsTimer);
  stopClock();
  unbindActivity();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// ---------- Clock ----------

function paintClock() {
  const now = new Date();
  el('kioskClockTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  el('kioskClockDate').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function startClock() {
  paintClock();
  clearInterval(clockTimer);
  clockTimer = setInterval(paintClock, 10000); // HH:MM only — 10s is plenty
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

// ---------- Auto-dim + on-screen controls ----------

function armDim() {
  clearTimeout(dimTimer);
  document.body.classList.remove('kiosk-dimmed');
  if (dimMinutes > 0) {
    dimTimer = setTimeout(() => document.body.classList.add('kiosk-dimmed'), dimMinutes * 60000);
  }
}

function wake() {
  document.body.classList.remove('kiosk-dimmed');
  armDim();
}

function showControls() {
  document.body.classList.add('kiosk-controls-shown');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => document.body.classList.remove('kiosk-controls-shown'), CONTROLS_HIDE_MS);
}

// Any input wakes a dimmed screen (or just re-arms the dim timer) and
// flashes the controls. Throttled so a stream of pointermove events isn't
// hundreds of timer churns a second. While dimmed the overlay has
// pointer-events:auto and its own click handler, so a wake *tap* lands on
// the overlay, not a widget control underneath.
function onActivity() {
  const now = Date.now();
  if (now - lastActivityArm < 500) return;
  lastActivityArm = now;
  if (document.body.classList.contains('kiosk-dimmed')) wake();
  else armDim();
  showControls();
}

function onKey(e) {
  if (e.key === 'Escape') { exitKiosk(); return; }
  wake();
}

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'touchstart'];

function bindActivity() {
  for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, onActivity, true);
  document.addEventListener('keydown', onKey, true);
}

function unbindActivity() {
  for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, onActivity, true);
  document.removeEventListener('keydown', onKey, true);
}

// ---------- Fullscreen ----------

function requestFs() {
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else requestFs();
}

// ---------- Wiring ----------

export function initKiosk() {
  dimMinutes = clampDim(localStorage.getItem(DIM_KEY));

  el('kioskDimOverlay').addEventListener('click', (e) => { e.stopPropagation(); wake(); });
  el('kioskExitBtn').addEventListener('click', exitKiosk);
  el('kioskFsBtn').addEventListener('click', () => { toggleFs(); showControls(); });
  el('enterKioskBtn').addEventListener('click', () => enterKiosk({ persist: true, fullscreen: true }));

  if (readEntry()) enterKiosk({ persist: true });
}
