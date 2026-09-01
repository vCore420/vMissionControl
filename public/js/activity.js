import { api } from './api.js';
import { state, el, escapeHtml, timeAgo, callbacks } from './core.js';

// Ops roadmap, Phase 1 — the Activity view. A filterable, live timeline over
// the audit log (server/activityLog.js). Filter state is per-device and not
// persisted; every open re-fetches. New entries arrive over the WebSocket
// (core.js#handleWsActivity → callbacks.onActivityEntry) and prepend when
// they match the active filter.

// 16 log categories collapsed into 5 colour buckets so the list reads at a
// glance without becoming a rainbow.
const BUCKET = {
  security: 'danger', auth: 'danger',
  control: 'accent', service: 'accent', schedule: 'accent',
  health: 'health',
  chat: 'content', code: 'content', file: 'content', timesheet: 'content',
  settings: 'muted', config: 'muted', group: 'muted', connection: 'muted',
  device: 'muted', discovery: 'muted', system: 'muted',
};
const CATS = ['auth', 'chat', 'code', 'config', 'connection', 'control', 'device',
  'discovery', 'file', 'group', 'health', 'schedule', 'security', 'service', 'settings', 'system', 'timesheet'];

let loading = false;
let hasMore = false;

function matchesFilter(entry) {
  const f = state.activityFilter;
  if (f.category && entry.category !== f.category) return false;
  if (f.search && !entry.message.toLowerCase().includes(f.search.toLowerCase())) return false;
  // time-window check — cheap, and keeps a live entry from showing under a
  // "last hour" filter if the clock's already moved past it (unlikely)
  if (Date.parse(entry.time) < Date.now() - f.hours * 3600e3) return false;
  return true;
}

function renderCats() {
  const wrap = el('activityCats');
  const f = state.activityFilter;
  const chip = (cat, label) =>
    `<button type="button" class="activity-cat ${(!f.category && !cat) || f.category === cat ? 'active' : ''}" data-cat="${cat}">${label}</button>`;
  wrap.innerHTML = chip('', 'All') + CATS.map((c) => chip(c, c)).join('');
  wrap.querySelectorAll('.activity-cat').forEach((b) => {
    b.addEventListener('click', () => {
      state.activityFilter.category = b.dataset.cat || null;
      renderCats();
      loadActivity();
    });
  });
}

function entryRow(e) {
  return `
    <div class="activity-row">
      <span class="activity-badge b-${BUCKET[e.category] || 'muted'}">${escapeHtml(e.category)}</span>
      <span class="activity-msg">${escapeHtml(e.message)}</span>
      <span class="activity-meta" title="${escapeHtml(e.time)}">${timeAgo(e.time)}${e.ip ? ` · ${escapeHtml(e.ip)}` : ''}</span>
    </div>`;
}

function renderList() {
  el('activityList').innerHTML = state.activityEntries.map(entryRow).join('');
  el('activityEmpty').classList.toggle('hidden', state.activityEntries.length > 0 || loading);
  el('activityMoreBtn').classList.toggle('hidden', !hasMore);
}

async function loadActivity({ append = false } = {}) {
  if (loading) return;
  loading = true;
  el('activityMoreBtn').disabled = true;
  const f = state.activityFilter;
  const params = { hours: f.hours, limit: 100 };
  if (f.category) params.category = f.category;
  if (f.search) params.search = f.search;
  if (append && state.activityEntries.length) params.before = state.activityEntries.at(-1).time;
  try {
    const { entries, hasMore: more } = await api.getActivity(params);
    state.activityEntries = append ? state.activityEntries.concat(entries) : entries;
    hasMore = more;
  } catch (err) {
    state.activityEntries = append ? state.activityEntries : [];
    el('activityEmpty').textContent = err.message;
  } finally {
    loading = false;
    el('activityMoreBtn').disabled = false;
    renderList();
  }
}

// core.js hands every live logActivity() entry here.
function onActivityEntry(entry) {
  if (!el('activityView').classList.contains('active')) return;
  if (!matchesFilter(entry)) return;
  state.activityEntries.unshift(entry);
  if (state.activityEntries.length > 400) state.activityEntries.pop();
  renderList();
}

let searchDebounce = null;
el('activitySearch').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.activityFilter.search = e.target.value.trim();
    loadActivity();
  }, 300);
});

el('activityRange').addEventListener('change', (e) => {
  state.activityFilter.hours = Number(e.target.value) || 24;
  loadActivity();
});

el('activityMoreBtn').addEventListener('click', () => loadActivity({ append: true }));

callbacks.onActivityEntry = onActivityEntry;

// Entry point — called from the view switch each time the tab is opened.
export function renderActivity() {
  renderCats();
  el('activitySearch').value = state.activityFilter.search;
  el('activityRange').value = String(state.activityFilter.hours);
  el('activityEmpty').textContent = 'Nothing in this window.';
  loadActivity();
}
