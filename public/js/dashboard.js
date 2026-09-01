import { api } from './api.js';
import { drawConnectionLines, buildAdjacency, highlightNeighbors, clearHighlight } from './connections.js';
import { renderMarkdown } from './markdown.js';
import {
  state, el, toast, escapeHtml, escapeAttr, copyToClipboard, groupById, loadAll,
  dragState, enableDragReorder, setLocal, artProgressListeners,
} from './core.js';

// Dashboard: service cards/list/graph views, the group filter chips, the
// Add/Edit Service modal (including the connections pill-toggle checklist
// and the start/stop/restart/logs controls), network discovery, and
// card drag-to-reorder. Exported render functions are wired into core.js's
// `callbacks` by app.js so the WS/poll sync engine can trigger them without
// this module needing to be imported by core.js.

const cardsById = new Map();
const graphNodesById = new Map();

const svgOverlay = el('connectionsOverlay');
const gridWrap = el('gridWrap');
const cardGrid = el('cardGrid');
const pinnedGrid = el('pinnedGrid');

// ---------- Group filters ----------

export function renderGroupFilters() {
  const wrap = el('groupFilters');
  wrap.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = 'group-chip' + (state.activeGroup === null ? ' active' : '');
  allChip.textContent = 'All';
  allChip.onclick = () => { state.activeGroup = null; renderCards(); renderOnlineBadge(); };
  wrap.appendChild(allChip);

  for (const g of state.config.groups) {
    const chip = document.createElement('button');
    chip.className = 'group-chip' + (state.activeGroup === g.id ? ' active' : '');
    chip.innerHTML = `<span class="dot" style="background:${g.color}"></span>${g.name}`;
    chip.onclick = () => { state.activeGroup = g.id; renderCards(); renderOnlineBadge(); };
    wrap.appendChild(chip);
  }
}

el('search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderCards();
});

// ---------- Cards ----------

function matchesSearch(s) {
  if (!state.search) return true;
  const hay = `${s.name} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase();
  return hay.includes(state.search);
}

function filteredServices() {
  return state.config.services.filter((s) => {
    if (state.activeGroup && s.group !== state.activeGroup) return false;
    return matchesSearch(s);
  });
}

function statusLabel(status) {
  if (!status) return { cls: 'checking', text: 'checking…' };
  if (status.effectiveStatus === 'degraded') {
    const names = (status.degradedBy || [])
      .map((id) => state.config.services.find((s) => s.id === id)?.name ?? id)
      .join(', ');
    return { cls: 'degraded', text: `degraded · ${names} down` };
  }
  if (status.status === 'online') {
    return { cls: 'online', text: status.detail ? `online · ${status.detail}` : `online · ${status.latencyMs}ms` };
  }
  if (status.status === 'offline') return { cls: 'offline', text: status.error === 'timeout' ? 'timeout' : 'offline' };
  return { cls: 'unmonitored', text: 'unmonitored' };
}

// Sites don't set custom emoji the way a self-hosted tool does, so an
// entry with no icon falls back to its favicon via Google's public
// favicon service (this always returns *something*, even a generic globe,
// so the fallback below is mostly a safety net for a malformed URL).
function faviconUrl(url) {
  try {
    const { hostname } = new URL(url);
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostname)}`;
  } catch {
    return null;
  }
}

// The one place the icon precedence lives (creative roadmap Phase 1b added
// the generated-icon tier on top): a ComfyUI-generated icon wins, then a
// picked emoji, then the site's favicon, then a plain link glyph. Returns
// { img } (a URL to render as <img>) xor { emoji } (text).
function serviceGlyph(service) {
  if (service.iconImage) return { img: api.serviceIconUrl(service.id, service.iconImage) };
  if (service.icon) return { emoji: service.icon };
  const fav = faviconUrl(service.url);
  return fav ? { img: fav } : { emoji: '🔗' };
}

const UPTIME_SAMPLES = 30;

function renderUptimeStrip(card, status) {
  const history = status?.history || [];
  const padCount = Math.max(0, UPTIME_SAMPLES - history.length);
  const bars = Array(padCount).fill('none').concat(history);
  card.querySelector('.uptime-strip').innerHTML = bars.map((h) => `<span class="uptime-bar ${h}"></span>`).join('');
  card.querySelector('.uptime-percent').textContent = status?.uptimePercent != null ? `${status.uptimePercent}%` : '—';
}

// Only shown once both Settings → Security has the feature switched on
// *and* this particular service has at least one command configured — the
// per-button visibility below then further narrows to just the actions
// that actually have a command, since e.g. a service might only have a
// restart hook and no separate start/stop.
function serviceControlAvailable(service) {
  const type = service.controller?.type;
  return !!(state.config.security.serviceControl.enabled && (type === 'script' || type === 'docker'));
}

// Wrapped in .control-btn-group so these render and wrap as one unit —
// without it, flex-wrap breaks the row wherever it runs out of space,
// which could leave e.g. Start on the first line and Stop/Restart/Logs
// stranded on the next, splitting one control cluster in two.
function controlButtonsMarkup(service, btnClass) {
  if (!serviceControlAvailable(service)) return '';
  const c = service.controller;
  // Docker actions are standardized by the Engine API itself — there's no
  // per-action command to check for, unlike script controllers where each
  // button only appears if that specific command was actually filled in.
  if (c.type === 'docker') {
    return `
      <span class="control-btn-group">
        <button type="button" class="${btnClass} control-btn" data-action="start" title="Start">▶</button>
        <button type="button" class="${btnClass} control-btn" data-action="stop" title="Stop">⏹</button>
        <button type="button" class="${btnClass} control-btn" data-action="restart" title="Restart">⟲</button>
        <button type="button" class="${btnClass} logs-btn" title="View logs">📜</button>
      </span>
    `;
  }
  return `
    <span class="control-btn-group">
      ${c.startCmd ? `<button type="button" class="${btnClass} control-btn" data-action="start" title="Start">▶</button>` : ''}
      ${c.stopCmd ? `<button type="button" class="${btnClass} control-btn" data-action="stop" title="Stop">⏹</button>` : ''}
      ${c.restartCmd ? `<button type="button" class="${btnClass} control-btn" data-action="restart" title="Restart">⟲</button>` : ''}
    </span>
  `;
}

const CONTROL_ACTION_LABELS = { start: 'Start', stop: 'Stop', restart: 'Restart' };
const CONTROL_API = { start: 'startService', stop: 'stopService', restart: 'restartService' };

// Stop/restart interrupt something already running, so they get a confirm
// dialog like deleteService does; start doesn't (nothing to lose).
async function runServiceControl(service, action, btn) {
  const label = CONTROL_ACTION_LABELS[action];
  if (action !== 'start' && !confirm(`${label} "${service.name}"? This runs a command on the host.`)) return;

  btn.classList.add('spinning');
  try {
    const result = await api[CONTROL_API[action]](service.id);
    toast(
      result.ok ? `"${service.name}" ${action} succeeded` : `"${service.name}" ${action} failed: ${result.error || 'unknown error'}`,
      !result.ok
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.classList.remove('spinning');
  }
}

function wireControlButtons(root, service) {
  root.querySelectorAll('.control-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runServiceControl(service, btn.dataset.action, btn);
    });
  });
  root.querySelectorAll('.logs-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLogsModal(service);
    });
  });
}

function buildCardElement(service, adjacency) {
  const group = groupById(service.group);
  const status = state.status.get(service.id);
  const sl = statusLabel(status);
  const connectionCount = (adjacency.get(service.id) || new Set()).size;

  const glyph = serviceGlyph(service);
  const iconMarkup = glyph.img
    ? `<img class="card-favicon" alt="" src="${escapeAttr(glyph.img)}" />`
    : `<div class="card-icon">${escapeHtml(glyph.emoji)}</div>`;

  const card = document.createElement('div');
  card.className = 'service-card';
  card.dataset.id = service.id;
  card.innerHTML = `
    <button class="card-edit-btn" title="Edit service">✎</button>
    <div class="card-icon-panel">
      ${iconMarkup}
      <div class="status-dot ${sl.cls}" title="${sl.text}"></div>
    </div>
    <div class="card-body">
      <div class="card-title-row">
        <button class="pin-toggle ${service.pinned ? 'pinned' : ''}" title="${service.pinned ? 'Unpin' : 'Pin to top'}">${service.pinned ? '★' : '☆'}</button>
        <div class="card-title">${escapeHtml(service.name)}</div>
      </div>
      <button type="button" class="card-url ${state.revealedUrls.has(service.id) ? 'revealed' : ''}">${state.revealedUrls.has(service.id) ? escapeHtml(service.url) : '🔒 Tap to reveal URL'}</button>
      <div class="card-meta">
        <span class="status-text">${sl.text}</span>
        ${group ? `<span class="card-group-badge" style="background:${group.color}22;color:${group.color}">${escapeHtml(group.name)}</span>` : ''}
        ${connectionCount > 0 ? `<span class="connection-badge" title="Connected to ${connectionCount} other service${connectionCount > 1 ? 's' : ''} — tap this card to see which">🔗 ${connectionCount}</span>` : ''}
      </div>
      <div class="uptime-row">
        <div class="uptime-strip"></div>
        <span class="uptime-percent">—</span>
      </div>
      ${service.description ? `<div class="card-desc">${escapeHtml(service.description)}</div>` : ''}
      ${service.tags?.length ? `<div class="card-tags">${service.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="card-quick-actions">
        <button class="icon-btn copy-btn" title="Copy link">📋</button>
        <a class="enter-btn" href="${escapeAttr(service.url)}" target="_blank" rel="noopener">Enter</a>
        <button class="icon-btn recheck-btn" title="Check now">⟳</button>
        ${service.mac ? '<button class="icon-btn wake-btn" title="Send a Wake-on-LAN packet">⚡</button>' : ''}
        ${service.game?.kind ? '<button type="button" class="icon-btn game-console-btn" title="Game console">🎮</button>' : ''}
        ${controlButtonsMarkup(service, 'icon-btn')}
      </div>
    </div>
  `;

  renderUptimeStrip(card, status);

  const faviconImg = card.querySelector('.card-favicon');
  if (faviconImg) {
    faviconImg.addEventListener('error', () => {
      faviconImg.outerHTML = '<div class="card-icon">🔗</div>';
    });
  }

  card.querySelector('.card-edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openServiceModal(service.id);
  });

  card.querySelector('.pin-toggle').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await api.updateService(service.id, { pinned: !service.pinned });
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
  });

  card.querySelector('.card-url').addEventListener('click', (e) => {
    e.stopPropagation();
    const urlBtn = e.currentTarget;
    if (state.revealedUrls.has(service.id)) {
      state.revealedUrls.delete(service.id);
      urlBtn.textContent = '🔒 Tap to reveal URL';
      urlBtn.classList.remove('revealed');
    } else {
      state.revealedUrls.add(service.id);
      urlBtn.textContent = service.url;
      urlBtn.classList.add('revealed');
    }
  });

  card.querySelector('.copy-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await copyToClipboard(service.url);
      toast('Link copied');
    } catch {
      toast('Could not copy link', true);
    }
  });

  card.querySelector('.recheck-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    try {
      const updated = await api.checkServiceNow(service.id);
      if (updated) {
        state.status.set(service.id, updated);
        renderCardStatuses();
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.classList.remove('spinning');
    }
  });

  card.querySelector('.wake-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    try {
      await api.wakeService(service.id);
      toast(`Wake packet sent to ${service.name}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.classList.remove('spinning');
    }
  });

  card.querySelector('.game-console-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openGameConsole(service);
  });

  wireControlButtons(card, service);

  // Click-to-toggle rather than hover: hover doesn't fire on touch devices
  // at all, so a mouse-only interaction here would make this invisible on
  // mobile. Ignore clicks on any button/link inside the card so this
  // doesn't fight with Enter/Edit/Pin/Copy/Recheck.
  if (connectionCount > 0) {
    card.classList.add('has-connections');
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    toggleHighlight(service.id);
  });

  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    dragState.originContainer = card.parentElement;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', service.id); // required by Firefox to start a drag
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragState.originContainer = null;
  });

  return card;
}

// Persistent (not hover-only) connection highlight, toggled by clicking or
// tapping a card — see buildCardElement for why hover alone isn't enough.
function toggleHighlight(serviceId) {
  if (state.highlightedServiceId === serviceId) {
    state.highlightedServiceId = null;
    clearHighlight(cardsById);
    return;
  }
  state.highlightedServiceId = serviceId;
  const adjacency = buildAdjacency(state.config.connections);
  highlightNeighbors(cardsById, adjacency, serviceId);
}

// ---------- Dashboard layout switcher (Card / List / Graph) ----------
// Per-device only (localStorage) — never touches config.json, so it never
// syncs to or overrides another device's view.

function setDashboardLayoutVisibility(mode) {
  cardGrid.classList.toggle('hidden', mode !== 'card');
  el('servicesListView').classList.toggle('hidden', mode !== 'list');
  el('servicesGraphView').classList.toggle('hidden', mode !== 'graph');
  el('servicesBoardView').classList.toggle('hidden', mode !== 'board');
  if (mode !== 'card') el('pinnedSection').classList.add('hidden');
  svgOverlay.classList.toggle('visible', mode === 'card' && state.connectionsVisible);
  // The board isn't a view of the services, so the group filter, the "add a
  // service" button, and the "no services yet" empty state don't apply to it.
  el('groupFilters').classList.toggle('hidden', mode === 'board');
  el('addServiceBtn').classList.toggle('hidden', mode === 'board');
  if (mode === 'board') el('emptyState').classList.add('hidden');
  // Leaving the board: stop the fetch-widget polling and force a rebuild
  // (which restarts the timers) on the way back in.
  if (mode !== 'board') {
    clearPollTimers();
    lastWidgetsSignature = null;
  }
}

export function renderCards() {
  setDashboardLayoutVisibility(state.dashboardViewMode);
  if (state.dashboardViewMode === 'list') renderServicesListView();
  else if (state.dashboardViewMode === 'graph') renderServicesGraphView();
  else if (state.dashboardViewMode === 'board') renderBoardView();
  else renderServicesCardView();
}

// ---------- Board view (creative roadmap Phase 3) ----------
// A 4th dashboard mode showing config.widgets — iframe / note / links / fetch /
// jellyfin / host-stats / service-status / clock / countdown / photo / docker
// tiles. Per-widget content can be an <iframe>, so a full rebuild on every
// unrelated config broadcast would reload embedded pages; renderBoardView
// skips the rebuild when the widgets array is byte-for-byte unchanged.

let lastWidgetsSignature = null;
const pollTimers = new Map(); // widget id -> interval handle (fetch, jellyfin, host-stats, clock, countdown, photo, docker)
const JELLYFIN_POLL_SEC = 5;
const photoState = new Map(); // photo widget id -> { images: string[], idx, loadedAt }

function clearPollTimers() {
  for (const t of pollTimers.values()) clearInterval(t);
  pollTimers.clear();
  photoState.clear(); // re-fetch each photo widget's image list on the next board build
}

async function refreshFetchWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-value`);
  if (!box) return;
  try {
    const { value, error } = await api.getWidgetValue(w.id);
    box.classList.toggle('is-error', !!error);
    box.textContent = error ? `⚠ ${error}` : value;
  } catch (err) {
    box.classList.add('is-error');
    box.textContent = `⚠ ${err.message}`;
  }
}

function fmtTime(sec) {
  if (!sec || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function refreshJellyfinWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-jellyfin`);
  if (!box) return;
  let data;
  try {
    data = await api.jellyfinNowPlaying();
  } catch (err) {
    box.innerHTML = `<div class="board-widget-jf-empty">⚠ ${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!data.configured) {
    box.innerHTML = `<div class="board-widget-jf-empty">Set up Jellyfin in Settings → Jellyfin</div>`;
    return;
  }
  if (data.error) {
    box.innerHTML = `<div class="board-widget-jf-empty">⚠ ${escapeHtml(data.error)}</div>`;
    return;
  }
  if (!data.sessions.length) {
    box.innerHTML = `<div class="board-widget-jf-empty">Nothing playing</div>`;
    return;
  }

  box.innerHTML = data.sessions.map((s) => {
    const pct = s.durationSec ? Math.min(100, Math.round((s.positionSec / s.durationSec) * 100)) : 0;
    const poster = s.itemId
      ? `<img class="board-widget-jf-poster" alt="" src="${escapeAttr(api.jellyfinImageUrl(s.itemId, s.imageTag))}" onerror="this.remove()" />`
      : '';
    return `
      <div class="board-widget-jf-session" data-session="${escapeAttr(s.sessionId)}">
        ${poster}
        <div class="board-widget-jf-info">
          <div class="board-widget-jf-title">${escapeHtml(s.title)}</div>
          ${s.subtitle ? `<div class="board-widget-jf-sub">${escapeHtml(String(s.subtitle))}</div>` : ''}
          <div class="board-widget-jf-meta">on ${escapeHtml(s.deviceName)}${s.userName ? ` · ${escapeHtml(s.userName)}` : ''}</div>
          <div class="board-widget-jf-bar"><span style="width:${pct}%"></span></div>
          <div class="board-widget-jf-time">${fmtTime(s.positionSec)}${s.durationSec ? ` / ${fmtTime(s.durationSec)}` : ''}</div>
          <div class="board-widget-jf-controls">
            <button type="button" data-cmd="PreviousTrack" title="Previous">⏮</button>
            <button type="button" data-cmd="PlayPause" title="${s.isPaused ? 'Play' : 'Pause'}">${s.isPaused ? '▶' : '⏸'}</button>
            <button type="button" data-cmd="NextTrack" title="Next">⏭</button>
            <button type="button" data-cmd="Stop" title="Stop">⏹</button>
          </div>
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('.board-widget-jf-session').forEach((row) => {
    const sessionId = row.dataset.session;
    row.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api.jellyfinCommand(sessionId, btn.dataset.cmd);
        } catch (err) {
          toast(err.message, true);
        }
        setTimeout(() => refreshJellyfinWidget(w), 500);
      });
    });
  });
}

// ---------- Board widgets: host-stats / service-status / clock / countdown (ops roadmap Phase 2a) ----------

function sparkline(values, { w = 120, h = 28 } = {}) {
  const nums = values.filter((v) => typeof v === 'number');
  if (nums.length < 2) return `<svg class="mini-spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const step = w / (nums.length - 1);
  const pts = nums.map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1)}`).join(' ');
  return `<svg class="mini-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>`;
}

async function refreshHostStatsWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-hoststats`);
  if (!box) return;
  try {
    const d = await api.getHostHistory();
    const hist = d.history || [];
    const rows = [
      ['CPU', d.cpuPercent, hist.map((s) => s.cpu)],
      ['Memory', d.memory ? Math.round((d.memory.used / d.memory.total) * 100) : null, hist.map((s) => s.mem)],
      ['Disk', d.disk ? Math.round((d.disk.used / d.disk.total) * 100) : null, hist.map((s) => s.disk)],
    ];
    box.innerHTML = rows.filter(([, pct]) => pct != null).map(([label, pct, series]) => `
      <div class="hoststat-row ${pct >= 92 ? 'high' : pct >= 80 ? 'mid' : ''}">
        <span class="hoststat-label">${label}</span>
        ${sparkline(series)}
        <span class="hoststat-pct">${pct}%</span>
      </div>`).join('') || '<div class="board-widget-empty">no host data</div>';
  } catch (err) {
    box.innerHTML = `<div class="board-widget-empty">⚠ ${escapeHtml(err.message)}</div>`;
  }
}

function renderServiceStatusWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-svcstatus`);
  if (!box) return;
  const ids = w.serviceIds || [];
  if (!ids.length) { box.innerHTML = '<div class="board-widget-empty">no services picked</div>'; return; }
  box.innerHTML = ids.map((id) => {
    const svc = state.config.services.find((s) => s.id === id);
    if (!svc) return '';
    const sl = statusLabel(state.status.get(id));
    return `<div class="svcstatus-row"><span class="status-dot ${sl.cls}"></span><span class="svcstatus-name">${escapeHtml(svc.name)}</span><span class="svcstatus-text">${escapeHtml(sl.text)}</span></div>`;
  }).join('');
}

function refreshServiceStatusWidgets() {
  for (const w of state.config.widgets || []) if (w.type === 'service-status') renderServiceStatusWidget(w);
}

function clockParts(w) {
  const now = new Date();
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (w.showSeconds) opts.second = '2-digit';
  if (w.timezone) opts.timeZone = w.timezone;
  let time, date;
  try {
    time = new Intl.DateTimeFormat('en-GB', opts).format(now);
    date = w.showDate ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(w.timezone ? { timeZone: w.timezone } : {}) }).format(now) : '';
  } catch {
    time = now.toLocaleTimeString();
    date = w.showDate ? now.toLocaleDateString() : '';
  }
  return { time, date, zone: w.timezone || '' };
}

function renderClockWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-clock`);
  if (!box) return;
  const { time, date, zone } = clockParts(w);
  box.innerHTML = `<div class="clock-time">${escapeHtml(time)}</div>${date ? `<div class="clock-date">${escapeHtml(date)}</div>` : ''}${zone ? `<div class="clock-zone">${escapeHtml(zone.replace(/_/g, ' '))}</div>` : ''}`;
}

function renderCountdownWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-countdown`);
  if (!box) return;
  const t = w.target ? Date.parse(w.target) : NaN;
  if (Number.isNaN(t)) { box.innerHTML = '<div class="board-widget-empty">no target set</div>'; return; }
  let ms = t - Date.now();
  const past = ms < 0;
  ms = Math.abs(ms);
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const big = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  box.innerHTML = `
    ${w.label ? `<div class="countdown-label">${escapeHtml(w.label)}</div>` : ''}
    <div class="countdown-big">${big}</div>
    <div class="countdown-sub">${past ? 'ago' : 'remaining'}</div>`;
}

// ---------- Photo widget (ops roadmap Phase 2b) ----------
// Rotates through the images in a shared-folder subdir. No new serving path:
// the list comes from GET /api/files and each frame is an <img> pointed at
// /api/files/download, exactly like the Files tab's thumbnail view. The
// image list is re-fetched occasionally so photos added on disk show up.

const PHOTO_IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
const PHOTO_LIST_TTL_MS = 10 * 60 * 1000;

async function loadPhotoList(w) {
  const rel = w.folder || '';
  const { items } = await api.listFiles(rel);
  let images = items.filter((it) => it.type === 'file' && PHOTO_IMG_RE.test(it.name))
    .map((it) => (rel ? `${rel}/${it.name}` : it.name));
  if (w.shuffle !== false) {
    for (let i = images.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [images[i], images[j]] = [images[j], images[i]];
    }
  }
  photoState.set(w.id, { images, idx: 0, loadedAt: Date.now() });
}

async function refreshPhotoWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-photo`);
  if (!box) return;
  try {
    let st = photoState.get(w.id);
    if (!st || Date.now() - st.loadedAt > PHOTO_LIST_TTL_MS) {
      await loadPhotoList(w);
      st = photoState.get(w.id);
    }
    if (!st.images.length) {
      box.innerHTML = `<div class="board-widget-empty">no images in ${escapeHtml(w.folder || 'the shared folder')}</div>`;
      return;
    }
    const path = st.images[st.idx % st.images.length];
    st.idx = (st.idx + 1) % st.images.length;
    const img = new Image();
    img.className = `photo-frame fit-${w.fit === 'contain' ? 'contain' : 'cover'}`;
    img.alt = '';
    img.src = api.downloadUrl(path);
    img.onload = () => { box.replaceChildren(img); };
    img.onerror = () => { box.innerHTML = '<div class="board-widget-empty">⚠ image failed to load</div>'; };
    if (!box.querySelector('img')) box.innerHTML = '<div class="board-widget-empty">…</div>';
  } catch (err) {
    const msg = /disabled/i.test(err.message) ? 'the shared folder is turned off' : err.message;
    box.innerHTML = `<div class="board-widget-empty">⚠ ${escapeHtml(msg)}</div>`;
  }
}

// ---------- Docker widget (ops roadmap Phase 2b) ----------
// Raw containers (not services): state + start/stop/restart/logs. Controls
// are Service-Control-gated server-side; this shows the gate rather than
// hiding the buttons, same as the game console.

async function refreshDockerWidget(w) {
  const box = el('boardGrid').querySelector(`.board-widget[data-id="${w.id}"] .board-widget-docker`);
  if (!box) return;
  const scOn = !!state.config.security?.serviceControl?.enabled && !!state.config.auth?.enabled;
  try {
    const { containers } = await api.getDockerContainers();
    const pick = new Set(w.containers || []);
    let rows = containers;
    if (pick.size) rows = containers.filter((c) => pick.has(c.name) || pick.has(c.id));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) {
      box.innerHTML = `<div class="board-widget-empty">${pick.size ? 'none of the picked containers exist' : 'no containers'}</div>`;
      return;
    }
    box.innerHTML = rows.map((c) => {
      const running = c.state === 'running';
      const toggle = running ? 'stop' : 'start';
      return `<div class="docker-row" data-name="${escapeAttr(c.name)}">
        <span class="status-dot ${running ? 'online' : 'offline'}"></span>
        <span class="docker-name" title="${escapeAttr(c.status || '')}">${escapeHtml(c.name)}</span>
        <span class="docker-actions">
          <button type="button" class="docker-btn" data-act="${toggle}" ${scOn ? '' : 'disabled'} title="${scOn ? '' : 'Service Control is off'}">${running ? '⏹' : '▶'}</button>
          <button type="button" class="docker-btn" data-act="restart" ${scOn && running ? '' : 'disabled'} title="${scOn ? 'Restart' : 'Service Control is off'}">⟳</button>
          <button type="button" class="docker-btn" data-act="logs" title="Logs">📜</button>
        </span>
      </div>`;
    }).join('');
    box.querySelectorAll('.docker-row').forEach((row) => {
      const name = row.dataset.name;
      row.querySelectorAll('.docker-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'logs') { openLogsFor({ kind: 'container', name }); return; }
          btn.disabled = true;
          try {
            await api.dockerContainerAction(name, act);
            toast(`${name}: ${act} sent`);
            setTimeout(() => refreshDockerWidget(w), 1500);
          } catch (err) {
            toast(err.message, true);
            btn.disabled = false;
          }
        });
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="board-widget-empty">⚠ ${escapeHtml(err.message)}</div>`;
  }
}

function startPollTimers() {
  for (const w of state.config.widgets || []) {
    if (w.type === 'fetch') {
      refreshFetchWidget(w);
      pollTimers.set(w.id, setInterval(() => refreshFetchWidget(w), Math.max(10, Number(w.refreshSec) || 60) * 1000));
    } else if (w.type === 'jellyfin') {
      refreshJellyfinWidget(w);
      pollTimers.set(w.id, setInterval(() => refreshJellyfinWidget(w), JELLYFIN_POLL_SEC * 1000));
    } else if (w.type === 'host-stats') {
      refreshHostStatsWidget(w);
      pollTimers.set(w.id, setInterval(() => refreshHostStatsWidget(w), 5000));
    } else if (w.type === 'clock') {
      renderClockWidget(w);
      pollTimers.set(w.id, setInterval(() => renderClockWidget(w), 1000));
    } else if (w.type === 'countdown') {
      renderCountdownWidget(w);
      pollTimers.set(w.id, setInterval(() => renderCountdownWidget(w), 1000));
    } else if (w.type === 'photo') {
      refreshPhotoWidget(w);
      pollTimers.set(w.id, setInterval(() => refreshPhotoWidget(w), Math.max(5, Number(w.rotateSec) || 20) * 1000));
    } else if (w.type === 'docker') {
      refreshDockerWidget(w);
      pollTimers.set(w.id, setInterval(() => refreshDockerWidget(w), 10000));
    } else if (w.type === 'service-status') {
      renderServiceStatusWidget(w); // no timer — rides status ticks via renderCardStatuses
    }
  }
}

function renderBoardView() {
  const widgets = state.config.widgets || [];
  const signature = JSON.stringify(widgets);
  const grid = el('boardGrid');
  if (signature === lastWidgetsSignature && grid.children.length === widgets.length) {
    el('boardEmpty').classList.toggle('hidden', widgets.length > 0);
    return;
  }
  lastWidgetsSignature = signature;

  clearPollTimers();
  grid.innerHTML = '';
  for (const w of widgets) grid.appendChild(buildWidgetElement(w));
  el('boardEmpty').classList.toggle('hidden', widgets.length > 0);
  startPollTimers();
}

function widgetBodyMarkup(w) {
  if (w.type === 'iframe') {
    return `<iframe class="board-widget-frame" src="${escapeAttr(w.url)}" style="height:${Number(w.height) || 260}px"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  }
  if (w.type === 'note') {
    return `<div class="board-widget-note">${renderMarkdown(w.markdown || '')}</div>`;
  }
  if (w.type === 'links') {
    const links = (w.links || [])
      .map((l) => `<a href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label || l.url)}</a>`)
      .join('');
    return `<div class="board-widget-links">${links || '<span class="board-widget-empty">no links yet</span>'}</div>`;
  }
  if (w.type === 'fetch') {
    return `<div class="board-widget-value">…</div>`;
  }
  if (w.type === 'jellyfin') {
    return `<div class="board-widget-jellyfin"><div class="board-widget-jf-empty">…</div></div>`;
  }
  if (w.type === 'host-stats') return `<div class="board-widget-hoststats">…</div>`;
  if (w.type === 'service-status') return `<div class="board-widget-svcstatus">…</div>`;
  if (w.type === 'clock') return `<div class="board-widget-clock"></div>`;
  if (w.type === 'countdown') return `<div class="board-widget-countdown"></div>`;
  if (w.type === 'photo') return `<div class="board-widget-photo"><div class="board-widget-empty">…</div></div>`;
  if (w.type === 'docker') return `<div class="board-widget-docker"><div class="board-widget-empty">…</div></div>`;
  return '';
}

function buildWidgetElement(w) {
  const node = document.createElement('div');
  node.className = `board-widget size-${w.size || 'sm'}`;
  node.dataset.id = w.id;
  node.setAttribute('draggable', 'true');
  node.innerHTML = `
    <div class="board-widget-head">
      <span class="board-widget-title">${escapeHtml(w.title || defaultWidgetTitle(w))}</span>
      <button type="button" class="board-widget-edit" title="Edit widget">✎</button>
    </div>
    <div class="board-widget-body">${widgetBodyMarkup(w)}</div>`;
  node.querySelector('.board-widget-edit').addEventListener('click', () => openWidgetModal(w.id));
  return node;
}

function defaultWidgetTitle(w) {
  if (w.type === 'iframe' || w.type === 'fetch') {
    try { return new URL(w.url).hostname; } catch { return w.type === 'fetch' ? 'Value' : 'Embedded page'; }
  }
  return {
    jellyfin: 'Now playing', 'host-stats': 'Host stats', 'service-status': 'Service status',
    clock: w.timezone ? w.timezone.split('/').pop().replace(/_/g, ' ') : 'Clock',
    countdown: w.label || 'Countdown', note: 'Note', links: 'Links',
    photo: w.folder ? w.folder.split('/').pop() : 'Photos', docker: 'Containers',
  }[w.type] || 'Widget';
}

function renderServicesCardView() {
  cardGrid.innerHTML = '';
  pinnedGrid.innerHTML = '';
  cardsById.clear();

  // Pinned services float to their own section regardless of the active
  // group filter (search still applies, so searching still narrows them).
  const pinned = state.config.services.filter((s) => s.pinned && matchesSearch(s));
  const regular = filteredServices().filter((s) => !s.pinned);
  const adjacency = buildAdjacency(state.config.connections);

  el('pinnedSection').classList.toggle('hidden', pinned.length === 0);

  for (const service of pinned) {
    const card = buildCardElement(service, adjacency);
    pinnedGrid.appendChild(card);
    cardsById.set(service.id, card);
  }
  for (const service of regular) {
    const card = buildCardElement(service, adjacency);
    cardGrid.appendChild(card);
    cardsById.set(service.id, card);
  }

  el('emptyState').classList.toggle('hidden', pinned.length + regular.length > 0);

  // A re-render (e.g. from a live config update) rebuilds every card node,
  // so a highlight from before the rebuild needs to be reapplied to the
  // fresh nodes or it'd silently vanish.
  if (state.highlightedServiceId) highlightNeighbors(cardsById, adjacency, state.highlightedServiceId);
  if (state.connectionsVisible) requestAnimationFrame(renderConnectionOverlay);
}

function rowFaviconOrIcon(service) {
  const glyph = serviceGlyph(service);
  return glyph.img ? `<img src="${escapeAttr(glyph.img)}" alt="" />` : escapeHtml(glyph.emoji);
}

function renderServicesListView() {
  const wrap = el('servicesListView');
  wrap.innerHTML = '';

  const services = filteredServices().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  el('emptyState').classList.toggle('hidden', services.length > 0);

  for (const service of services) {
    const group = groupById(service.group);
    const status = state.status.get(service.id);
    const sl = statusLabel(status);

    const row = document.createElement('div');
    row.className = 'service-row';
    row.dataset.id = service.id;
    row.innerHTML = `
      <span class="status-dot ${sl.cls}" title="${sl.text}"></span>
      <span class="row-icon">${rowFaviconOrIcon(service)}</span>
      ${service.pinned ? '<span class="row-star" title="Pinned">★</span>' : ''}
      <span class="row-name">${escapeHtml(service.name)}</span>
      <span class="row-meta">${sl.text}${group ? ' · ' + escapeHtml(group.name) : ''}${service.description ? ' · ' + escapeHtml(service.description) : ''}</span>
      <span class="row-uptime">${status?.uptimePercent != null ? status.uptimePercent + '%' : '—'}</span>
      <span class="row-actions">
        <button type="button" class="icon-btn row-edit-btn" title="Edit">✎</button>
        ${service.mac ? '<button type="button" class="icon-btn row-wake-btn" title="Send a Wake-on-LAN packet">⚡</button>' : ''}
        ${controlButtonsMarkup(service, 'icon-btn')}
        <a class="icon-btn row-enter-btn" href="${escapeAttr(service.url)}" target="_blank" rel="noopener" title="Enter">↗</a>
      </span>
    `;
    row.querySelector('.row-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openServiceModal(service.id);
    });
    row.querySelector('.row-wake-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api.wakeService(service.id);
        toast(`Wake packet sent to ${service.name}`);
      } catch (err) {
        toast(err.message, true);
      }
    });
    wireControlButtons(row, service);
    wrap.appendChild(row);
  }
}

function renderServicesGraphView() {
  const container = el('graphNodes');
  const svg = el('graphOverlay');
  const graphView = el('servicesGraphView');
  container.innerHTML = '';
  graphNodesById.clear();

  const services = filteredServices();
  el('emptyState').classList.toggle('hidden', services.length > 0);
  if (services.length === 0) {
    svg.innerHTML = '';
    return;
  }

  const rect = graphView.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  // Read from CSS (--graph-node-margin, .services-graph in style.css)
  // rather than a hardcoded number here, so the mobile breakpoint's
  // smaller node footprint and this margin can't quietly drift out of
  // sync — a fixed JS constant paired with a fixed node size was exactly
  // what caused nodes to overlap on mobile in the first place.
  const nodeMargin = parseFloat(getComputedStyle(graphView).getPropertyValue('--graph-node-margin')) || 70;
  const radius = Math.max(60, Math.min(cx, cy) - nodeMargin);

  services.forEach((service, i) => {
    const angle = (i / services.length) * 2 * Math.PI - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    const status = state.status.get(service.id);
    const sl = statusLabel(status);

    const node = document.createElement('div');
    node.className = `graph-node ${sl.cls} ${service.pinned ? 'pinned' : ''}`;
    node.dataset.id = service.id;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.title = `${service.name} — ${sl.text}`;
    node.innerHTML = `
      <div class="graph-node-icon">${rowFaviconOrIcon(service)}</div>
      <div class="graph-node-label">${escapeHtml(service.name)}</div>
    `;
    node.addEventListener('click', () => window.open(service.url, '_blank', 'noopener'));

    container.appendChild(node);
    graphNodesById.set(service.id, node);
  });

  drawConnectionLines(svg, graphView, state.config.connections, graphNodesById);
}

export function renderCardStatuses() {
  // On the board, a status tick patches any service-status widget in place
  // (a full rebuild would reload the iframes) and the online badge.
  if (state.dashboardViewMode === 'board') {
    refreshServiceStatusWidgets();
    renderOnlineBadge();
    return;
  }
  if (state.dashboardViewMode === 'card') {
    for (const [id, card] of cardsById) {
      const status = state.status.get(id);
      const sl = statusLabel(status);
      const dot = card.querySelector('.status-dot');
      dot.className = `status-dot ${sl.cls}`;
      dot.title = sl.text;
      card.querySelector('.status-text').textContent = sl.text;
      renderUptimeStrip(card, status);
    }
  } else {
    // List/graph rows have no per-item local UI state worth preserving
    // (no drag handles, no reveal-toggle, nothing mid-interaction), so a
    // full rebuild on every status update is simpler than teaching two
    // more layouts to patch themselves in place.
    renderCards();
  }
  renderOnlineBadge();
}

export function renderOnlineBadge() {
  const total = state.config.services.length;
  const online = state.config.services.filter((s) => state.status.get(s.id)?.status === 'online').length;
  const badge = el('onlineBadge');
  badge.textContent = `${online}/${total}`;
  badge.title = `${online} of ${total} services online`;
}

export function renderConnectionOverlay() {
  drawConnectionLines(svgOverlay, gridWrap, state.config.connections, cardsById);
}

el('toggleConnections').addEventListener('click', () => {
  state.connectionsVisible = !state.connectionsVisible;
  el('toggleConnections').classList.toggle('active', state.connectionsVisible);
  svgOverlay.classList.toggle('visible', state.dashboardViewMode === 'card' && state.connectionsVisible);
  if (state.connectionsVisible) {
    renderConnectionOverlay();
    if (!localStorage.getItem('mc:seenConnectionsHint')) {
      toast('Tap a card with a 🔗 badge to see what it’s connected to');
      setLocal('mc:seenConnectionsHint', 'true');
    }
  }
});

el('dashboardLayoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  state.dashboardViewMode = btn.dataset.layout;
  setLocal('mc:dashboardView', state.dashboardViewMode);
  el('dashboardLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  renderCards();
});

window.addEventListener('resize', () => {
  if (state.dashboardViewMode === 'card' && state.connectionsVisible) renderConnectionOverlay();
  if (state.dashboardViewMode === 'graph') renderServicesGraphView();
});

// ---------- Network discovery ----------
// The browser can't open raw TCP sockets itself, so the actual subnet scan
// runs server-side (server/discovery.js); this just kicks it off and polls
// its progress while the modal is open. Ports that look like a specific
// known app (Jellyfin, Ollama, etc.) suggest that name; generic ports
// (plain HTTP/HTTPS/SSH/...) suggest the bare IP instead, since "HTTP"
// isn't a useful service name.

const discoveryModal = el('discoveryModal');
const GENERIC_PORT_LABEL_RE = /^(HTTP|HTTPS|SSH|SMB|RDP|Web \(|Port )/;
let discoveryPollTimer = null;

function existingServiceEndpoints() {
  const set = new Set();
  for (const s of state.config.services) {
    try {
      const { hostname, port, protocol } = new URL(s.url);
      set.add(`${hostname}:${port || (protocol === 'https:' ? '443' : '80')}`);
    } catch {
      // malformed/incomplete URL on an existing entry — just skip it for this check
    }
  }
  return set;
}

function guessServiceUrl(ip, port) {
  return port === 443 || port === 8443 ? `https://${ip}:${port}` : `http://${ip}:${port}`;
}

function renderDiscoveryResults(scan) {
  const wrap = el('discoveryResults');
  const progress = el('discoveryProgress');

  progress.classList.toggle('hidden', !scan.total);
  if (scan.total) {
    const pct = Math.round((scan.progress / scan.total) * 100);
    el('discoveryProgressFill').style.width = `${pct}%`;
    el('discoveryProgressLabel').textContent = scan.running
      ? `Scanning… ${scan.progress}/${scan.total} addresses (${scan.results.length} found)`
      : `Done — checked ${scan.total} addresses, found ${scan.results.length}`;
  }

  el('startScanBtn').disabled = scan.running;
  el('startScanBtn').textContent = scan.running ? 'Scanning…' : 'Scan network';

  if (scan.error) {
    wrap.innerHTML = `<p class="empty-state">${escapeHtml(scan.error)}</p>`;
    return;
  }

  if (!scan.results.length) {
    wrap.innerHTML = scan.running
      ? '<p class="empty-state">Looking for devices…</p>'
      : '<p class="empty-state">No scan yet — click "Scan network" to look for devices on your LAN.</p>';
    return;
  }

  const existing = existingServiceEndpoints();

  wrap.innerHTML = scan.results.map((device) => `
    <div class="discovery-device">
      <div class="discovery-device-header">
        <span class="discovery-ip">${escapeHtml(device.ip)}</span>
        ${device.hostname ? `<span class="discovery-hostname">${escapeHtml(device.hostname)}</span>` : ''}
        ${device.mac ? `<span class="discovery-hostname" title="Found in this machine's ARP cache — enables one-click Wake-on-LAN when added">📡 ${escapeHtml(device.mac)}</span>` : ''}
      </div>
      <div class="discovery-ports">
        ${device.ports.map((p) => {
          const added = existing.has(`${device.ip}:${p.port}`);
          return `
            <div class="discovery-port ${added ? 'added' : ''}">
              <span class="discovery-port-label">${escapeHtml(p.label)} <span class="discovery-port-number">:${p.port}</span></span>
              <button type="button" class="btn ghost discovery-add-btn" data-ip="${escapeAttr(device.ip)}" data-port="${p.port}" data-label="${escapeAttr(p.label)}" data-mac="${escapeAttr(device.mac || '')}" ${added ? 'disabled' : ''}>${added ? 'Added' : '+ Add'}</button>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.discovery-add-btn:not(:disabled)').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { ip, port, label, mac } = btn.dataset;
      closeDiscoveryModal();
      openServiceModal(null, {
        name: GENERIC_PORT_LABEL_RE.test(label) ? ip : label,
        url: guessServiceUrl(ip, Number(port)),
        mac,
      });
    });
  });
}

async function refreshDiscoveryState() {
  try {
    const scan = await api.getDiscoveryScan();
    renderDiscoveryResults(scan);
    if (!scan.running && discoveryPollTimer) {
      clearInterval(discoveryPollTimer);
      discoveryPollTimer = null;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function openDiscoveryModal() {
  discoveryModal.classList.remove('hidden');
  refreshDiscoveryState();
}

function closeDiscoveryModal() {
  discoveryModal.classList.add('hidden');
  clearInterval(discoveryPollTimer);
  discoveryPollTimer = null;
}

el('openDiscovery').addEventListener('click', openDiscoveryModal);
el('closeDiscoveryBtn').addEventListener('click', closeDiscoveryModal);
discoveryModal.addEventListener('click', (e) => { if (e.target === discoveryModal) closeDiscoveryModal(); });

el('startScanBtn').addEventListener('click', async () => {
  try {
    const scan = await api.startDiscoveryScan();
    renderDiscoveryResults(scan);
    if (!discoveryPollTimer) discoveryPollTimer = setInterval(refreshDiscoveryState, 1000);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Card drag-to-reorder ----------
// Pinned and regular cards reorder independently within their own grid —
// dragging never moves a card between sections (that's what the pin star
// is for).

function applyLocalReorder(ids) {
  const byId = new Map(state.config.services.map((s) => [s.id, s]));
  const idSet = new Set(ids);
  let cursor = 0;
  state.config.services = state.config.services.map((s) => (idSet.has(s.id) ? byId.get(ids[cursor++]) : s));
}

enableDragReorder(cardGrid, {
  reorder: api.reorderServices,
  onSuccess: (ids) => {
    applyLocalReorder(ids);
    if (state.connectionsVisible) renderConnectionOverlay();
  },
  onError: loadAll,
});
enableDragReorder(pinnedGrid, {
  reorder: api.reorderServices,
  onSuccess: (ids) => {
    applyLocalReorder(ids);
    if (state.connectionsVisible) renderConnectionOverlay();
  },
  onError: loadAll,
});

enableDragReorder(el('boardGrid'), {
  itemSelector: '.board-widget',
  reorder: api.reorderWidgets,
  onSuccess: (ids) => {
    const byId = new Map((state.config.widgets || []).map((w) => [w.id, w]));
    state.config.widgets = ids.map((id) => byId.get(id));
    lastWidgetsSignature = JSON.stringify(state.config.widgets);
  },
  onError: loadAll,
});

// ---------- Board widget modal (creative roadmap Phase 3) ----------

const widgetModal = el('widgetModal');
const widgetForm = el('widgetForm');
let editingWidgetId = null;

function setWidgetTypeFields(type) {
  el('widgetIframeFields').classList.toggle('hidden', type !== 'iframe');
  el('widgetNoteFields').classList.toggle('hidden', type !== 'note');
  el('widgetLinksFields').classList.toggle('hidden', type !== 'links');
  el('widgetFetchFields').classList.toggle('hidden', type !== 'fetch');
  el('widgetHostStatsFields').classList.toggle('hidden', type !== 'host-stats');
  el('widgetServiceStatusFields').classList.toggle('hidden', type !== 'service-status');
  el('widgetClockFields').classList.toggle('hidden', type !== 'clock');
  el('widgetCountdownFields').classList.toggle('hidden', type !== 'countdown');
  el('widgetPhotoFields').classList.toggle('hidden', type !== 'photo');
  el('widgetDockerFields').classList.toggle('hidden', type !== 'docker');
}

// The 'docker' widget's picker — a live checklist of the host's containers,
// fetched when the modal opens. Any already-picked name that isn't currently
// present is kept as a checked row so editing doesn't silently drop it.
async function renderWidgetDockerChecklist(picked) {
  const box = el('widgetDockerChecklist');
  const set = new Set(picked || []);
  box.innerHTML = '<p class="settings-hint" style="margin:0;">Loading containers…</p>';
  try {
    const { containers } = await api.getDockerContainers();
    const present = new Set(containers.map((c) => c.name));
    for (const p of set) if (!present.has(p)) containers.push({ name: p, state: 'not found' });
    box.innerHTML = containers.map((c) => `
      <label><input type="checkbox" value="${escapeAttr(c.name)}" ${set.has(c.name) ? 'checked' : ''} /> ${escapeHtml(c.name)} <span style="color:var(--text-faint);">(${escapeHtml(c.state)})</span></label>
    `).join('') || '<p class="settings-hint" style="margin:0;">No containers found.</p>';
  } catch (err) {
    box.innerHTML = `<p class="settings-hint" style="margin:0;">Couldn't reach Docker — ${escapeHtml(err.message)}. Leave this blank and the widget will show all containers once Docker is reachable.</p>`;
  }
}

function renderWidgetServiceChecklist(picked) {
  const set = new Set(picked || []);
  el('widgetServiceChecklist').innerHTML = state.config.services.map((s) => `
    <label><input type="checkbox" value="${escapeAttr(s.id)}" ${set.has(s.id) ? 'checked' : ''} /> ${escapeHtml(s.name)}</label>
  `).join('') || '<p class="settings-hint" style="margin:0;">No services yet.</p>';
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in the viewer's
// local time; the widget stores an ISO string (UTC). toISOString().slice()
// would show the target shifted by the UTC offset, so format from the
// local getters instead.
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A handful of common zones for the datalist — the field still accepts any
// valid IANA name (the server validates).
const COMMON_TZ = [
  'Pacific/Auckland', 'Australia/Sydney', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
  'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC',
];

function renderWidgetLinkRows(links) {
  const wrap = el('widgetLinksList');
  wrap.innerHTML = (links.length ? links : [{ label: '', url: '' }])
    .map((l, i) => `
      <div class="widget-link-row" data-i="${i}">
        <input class="widget-link-label" placeholder="Label" value="${escapeAttr(l.label || '')}" maxlength="60" />
        <input class="widget-link-url" placeholder="https://…" value="${escapeAttr(l.url || '')}" maxlength="2000" />
        <button type="button" class="btn ghost widget-link-remove">✕</button>
      </div>`)
    .join('');
  wrap.querySelectorAll('.widget-link-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('.widget-link-row').remove();
    });
  });
}

function collectWidgetLinks() {
  return Array.from(el('widgetLinksList').querySelectorAll('.widget-link-row')).map((row) => ({
    label: row.querySelector('.widget-link-label').value.trim(),
    url: row.querySelector('.widget-link-url').value.trim(),
  })).filter((l) => l.url);
}

function openWidgetModal(widgetId = null) {
  editingWidgetId = widgetId;
  widgetForm.reset();
  el('widgetFormError').classList.add('hidden');
  const w = widgetId ? (state.config.widgets || []).find((x) => x.id === widgetId) : null;

  el('widgetModalTitle').textContent = w ? 'Edit widget' : 'Add a widget';
  el('deleteWidgetBtn').classList.toggle('hidden', !w);
  // Type is fixed once created — a tile is what it was made as.
  el('widgetTypeSelect').disabled = !!w;
  el('widgetTypeSelect').value = w ? w.type : 'iframe';
  widgetForm.elements.title.value = w?.title || '';
  el('widgetSizeSelect').value = w?.size || 'sm';
  widgetForm.elements.url.value = w?.type === 'iframe' ? (w?.url || '') : '';
  widgetForm.elements.height.value = w?.height || '';
  widgetForm.elements.markdown.value = w?.markdown || '';
  widgetForm.elements.fetchUrl.value = w?.type === 'fetch' ? (w?.url || '') : '';
  widgetForm.elements.template.value = w?.template || '';
  widgetForm.elements.refreshSec.value = w?.refreshSec || '';
  widgetForm.elements.timezone.value = w?.timezone || '';
  widgetForm.elements.showSeconds.checked = !!w?.showSeconds;
  widgetForm.elements.showDate.checked = w ? w.showDate !== false : true;
  widgetForm.elements.target.value = w?.target ? isoToLocalInput(w.target) : '';
  widgetForm.elements.label.value = w?.label || '';
  widgetForm.elements.folder.value = w?.folder || '';
  widgetForm.elements.rotateSec.value = w?.rotateSec || '';
  widgetForm.elements.fit.value = w?.fit === 'contain' ? 'contain' : 'cover';
  widgetForm.elements.shuffle.checked = w ? w.shuffle !== false : true;
  renderWidgetLinkRows(w?.links || []);
  renderWidgetServiceChecklist(w?.serviceIds);
  if ((w ? w.type : 'iframe') === 'docker') renderWidgetDockerChecklist(w?.containers);
  el('tzList').innerHTML = COMMON_TZ.map((z) => `<option value="${z}">`).join('');
  setWidgetTypeFields(w ? w.type : 'iframe');

  widgetModal.classList.remove('hidden');
}

function closeWidgetModal() {
  widgetModal.classList.add('hidden');
  editingWidgetId = null;
}

el('widgetTypeSelect').addEventListener('change', (e) => {
  setWidgetTypeFields(e.target.value);
  if (e.target.value === 'docker') renderWidgetDockerChecklist([]);
});
el('addWidgetBtn').addEventListener('click', () => openWidgetModal(null));
el('cancelWidgetBtn').addEventListener('click', closeWidgetModal);
widgetModal.addEventListener('click', (e) => { if (e.target === widgetModal) closeWidgetModal(); });
el('widgetAddLinkBtn').addEventListener('click', () => {
  const rows = collectWidgetLinks();
  rows.push({ label: '', url: '' });
  renderWidgetLinkRows(rows);
});

widgetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = el('widgetTypeSelect').value;
  const payload = {
    type,
    title: widgetForm.elements.title.value.trim(),
    size: el('widgetSizeSelect').value,
  };
  if (type === 'iframe') {
    payload.url = widgetForm.elements.url.value.trim();
    payload.height = Number(widgetForm.elements.height.value) || 260;
  } else if (type === 'note') {
    payload.markdown = widgetForm.elements.markdown.value;
  } else if (type === 'links') {
    payload.links = collectWidgetLinks();
  } else if (type === 'fetch') {
    payload.url = widgetForm.elements.fetchUrl.value.trim();
    payload.template = widgetForm.elements.template.value;
    payload.refreshSec = Number(widgetForm.elements.refreshSec.value) || 60;
  } else if (type === 'service-status') {
    payload.serviceIds = Array.from(el('widgetServiceChecklist').querySelectorAll('input:checked')).map((i) => i.value);
  } else if (type === 'clock') {
    payload.timezone = widgetForm.elements.timezone.value.trim();
    payload.showSeconds = widgetForm.elements.showSeconds.checked;
    payload.showDate = widgetForm.elements.showDate.checked;
  } else if (type === 'countdown') {
    const v = widgetForm.elements.target.value;
    payload.target = v ? new Date(v).toISOString() : '';
    payload.label = widgetForm.elements.label.value.trim();
  } else if (type === 'photo') {
    payload.folder = widgetForm.elements.folder.value.trim();
    payload.rotateSec = Number(widgetForm.elements.rotateSec.value) || 20;
    payload.fit = widgetForm.elements.fit.value === 'contain' ? 'contain' : 'cover';
    payload.shuffle = widgetForm.elements.shuffle.checked;
  } else if (type === 'docker') {
    payload.containers = Array.from(el('widgetDockerChecklist').querySelectorAll('input:checked')).map((i) => i.value);
  }

  try {
    if (editingWidgetId) await api.updateWidget(editingWidgetId, payload);
    else await api.addWidget(payload);
    await loadAll();
    lastWidgetsSignature = null; // force the board to rebuild with the change
    renderCards();
    closeWidgetModal();
  } catch (err) {
    el('widgetFormError').textContent = err.message;
    el('widgetFormError').classList.remove('hidden');
  }
});

el('deleteWidgetBtn').addEventListener('click', async () => {
  if (!editingWidgetId) return;
  try {
    await api.deleteWidget(editingWidgetId);
    await loadAll();
    lastWidgetsSignature = null;
    renderCards();
    closeWidgetModal();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Add/Edit service modal ----------

const serviceModal = el('serviceModal');
const serviceForm = el('serviceForm');

serviceForm.elements.url.addEventListener('input', () => {
  if (state.editingServiceId) return; // don't second-guess an explicit edit
  serviceForm.elements.healthCheck.checked = isLocalUrl(serviceForm.elements.url.value);
});

function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  } catch {
    return true; // incomplete URL while typing — don't assume external yet
  }
}

function populateGroupSelect() {
  const select = el('serviceGroupSelect');
  select.innerHTML = '<option value="">No group</option>' +
    state.config.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
}

// Each row is either editable (a 3-way None/Related/Depends-on pill
// toggle) or a read-only "reverse" row (another service marked *itself*
// as depending on this one) — reverse rows can only be removed here,
// never re-typed, so editing a dependency always happens from the
// dependent service's own modal. One toggle instead of a checkbox plus a
// separately-enabled dropdown, since it's really one 3-state choice, not
// two independent ones.
const CONNECTION_TYPE_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'related', label: 'Related' },
  { value: 'depends-on', label: 'Depends on' },
];

function populateConnectionsChecklist(currentId) {
  const wrap = el('connectionsChecklist');
  const others = state.config.services.filter((s) => s.id !== currentId);

  if (others.length === 0) {
    wrap.innerHTML = '<p class="connections-empty">Add more services to connect them.</p>';
    return;
  }

  wrap.innerHTML = others.map((s) => {
    const conn = currentId
      ? state.config.connections.find(
          (c) => (c.from === currentId && c.to === s.id) || (c.from === s.id && c.to === currentId)
        )
      : null;
    const isReverse = !!conn && conn.type === 'depends-on' && conn.from === s.id;
    const type = conn?.type || '';

    if (isReverse) {
      return `
        <div class="connection-row connection-row-reverse" data-id="${s.id}">
          <span class="connection-row-label">${s.icon || ''} ${escapeHtml(s.name)}</span>
          <span class="connection-reverse-hint">🔒 depends on this</span>
          <button type="button" class="connection-remove-btn" data-conn-id="${conn.id}" title="Remove this dependency">✕</button>
        </div>
      `;
    }

    return `
      <div class="connection-row" data-id="${s.id}" data-selected="${type}">
        <span class="connection-row-label">${s.icon || ''} ${escapeHtml(s.name)}</span>
        <div class="connection-type-toggle" role="group" aria-label="Connection to ${escapeAttr(s.name)}">
          ${CONNECTION_TYPE_OPTIONS.map(
            (opt) => `<button type="button" class="ctt-btn ${type === opt.value ? 'active' : ''}" data-value="${opt.value}">${opt.label}</button>`
          ).join('')}
        </div>
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('.ctt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.connection-row');
      row.dataset.selected = btn.dataset.value;
      row.querySelectorAll('.ctt-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  wrap.querySelectorAll('.connection-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api.deleteConnection(btn.dataset.connId);
        state.config.connections = state.config.connections.filter((c) => c.id !== btn.dataset.connId);
        populateConnectionsChecklist(currentId);
        toast('Connection removed');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function updateControllerFieldVisibility(type) {
  el('controllerScriptFields').classList.toggle('hidden', type !== 'script');
  el('controllerDockerFields').classList.toggle('hidden', type !== 'docker');
}

el('controllerTypeSelect').addEventListener('change', (e) => updateControllerFieldVisibility(e.target.value));

function updateGameFieldVisibility(kind) {
  el('gameMinecraftFields').classList.toggle('hidden', kind !== 'minecraft');
  el('gameFivemFields').classList.toggle('hidden', kind !== 'fivem');
}
el('gameKindSelect').addEventListener('change', (e) => updateGameFieldVisibility(e.target.value));

// The health check path is meaningless for a Tailscale-CLI check, so it's
// hidden rather than just left inert — same instinct as the controller
// type fields above.
el('tailscaleHealthCheckInput').addEventListener('change', (e) => {
  el('healthCheckPathField').classList.toggle('hidden', e.target.checked);
});

export function openServiceModal(serviceId = null, prefill = null) {
  state.editingServiceId = serviceId;
  populateGroupSelect();
  serviceForm.reset();
  el('serviceForm').elements.healthCheck.checked = true;
  el('deleteServiceBtn').classList.toggle('hidden', !serviceId);
  el('containerPickerList').classList.add('hidden');
  el('containerPickerList').innerHTML = '';
  el('containerPickerError').classList.add('hidden');
  el('healthCheckPathField').classList.remove('hidden');

  if (serviceId) {
    const s = state.config.services.find((x) => x.id === serviceId);
    el('serviceModalTitle').textContent = 'Edit Service';
    serviceForm.elements.name.value = s.name;
    serviceForm.elements.url.value = s.url;
    serviceForm.elements.icon.value = s.icon || '';
    serviceForm.elements.group.value = s.group || '';
    serviceForm.elements.description.value = s.description || '';
    serviceForm.elements.tags.value = (s.tags || []).join(', ');
    serviceForm.elements.healthCheck.checked = s.healthCheck;
    serviceForm.elements.healthCheckPath.value = s.healthCheckPath || '/';
    serviceForm.elements.tailscaleHealthCheck.checked = !!s.tailscaleHealthCheck;
    el('healthCheckPathField').classList.toggle('hidden', !!s.tailscaleHealthCheck);
    serviceForm.elements.mac.value = s.mac || '';
    const controllerType = s.controller?.type || '';
    serviceForm.elements.controllerType.value = controllerType;
    serviceForm.elements.controllerStartCmd.value = s.controller?.startCmd || '';
    serviceForm.elements.controllerStopCmd.value = s.controller?.stopCmd || '';
    serviceForm.elements.controllerRestartCmd.value = s.controller?.restartCmd || '';
    serviceForm.elements.controllerContainer.value = s.controller?.container || '';
    updateControllerFieldVisibility(controllerType);
    const gameKind = s.game?.kind || '';
    serviceForm.elements.gameKind.value = gameKind;
    serviceForm.elements.gameRconHost.value = s.game?.rconHost || '';
    serviceForm.elements.gameRconPort.value = s.game?.rconPort || '';
    serviceForm.elements.gameRconPassword.value = '';
    serviceForm.elements.gameRconPassword.placeholder = s.game?.hasRconPassword
      ? 'a password is saved — paste a new one to replace it'
      : 'paste an RCON password';
    el('gameRconKeyHint').textContent = s.game?.hasRconPassword
      ? 'A password is stored. Leave blank to keep it.'
      : '';
    serviceForm.elements.gameQueryUrl.value = s.game?.queryUrl || '';
    serviceForm.elements.gameTxAdminUrl.value = s.game?.txAdminUrl || '';
    updateGameFieldVisibility(gameKind);
  } else {
    el('serviceModalTitle').textContent = 'Add Service';
    serviceForm.elements.healthCheckPath.value = '/';
    updateControllerFieldVisibility('');
    updateGameFieldVisibility('');
    el('gameRconKeyHint').textContent = '';
    // Used by the network discovery flow to hand off a found ip:port (and,
    // when the OS's ARP cache had it, a MAC address for Wake-on-LAN) —
    // otherwise every other "Add Service" path leaves this null.
    if (prefill) {
      serviceForm.elements.name.value = prefill.name || '';
      serviceForm.elements.url.value = prefill.url || '';
      serviceForm.elements.mac.value = prefill.mac || '';
      serviceForm.elements.healthCheck.checked = isLocalUrl(prefill.url || '');
    }
  }

  renderServiceIconGenerate();
  populateConnectionsChecklist(serviceId);
  serviceModal.classList.remove('hidden');
}

// Icon generation (creative roadmap Phase 1b) — only offered on an
// already-saved service (needs its id + its name/description as the prompt),
// and only when ComfyUI is set up. On success the 'config' broadcast
// re-renders the cards; here we just refresh the modal's own preview.
let serviceIconBusy = false;

function renderServiceIconGenerate() {
  const box = el('serviceIconGenerate');
  if (!box) return;
  const id = state.editingServiceId;
  const service = id && state.config.services.find((s) => s.id === id);
  const show = !!service && !!state.config?.comfy?.enabled;
  box.classList.toggle('hidden', !show);
  if (!show) return;

  const hasIcon = !!service.iconImage;
  el('serviceIconPreview').innerHTML = hasIcon
    ? `<img alt="" src="${escapeAttr(api.serviceIconUrl(service.id, service.iconImage))}" />`
    : '<span class="service-icon-preview-empty">no generated icon</span>';
  el('removeServiceIconBtn').classList.toggle('hidden', !hasIcon);
  el('generateServiceIconBtn').disabled = serviceIconBusy;
  el('serviceIconExtra').disabled = serviceIconBusy;
}

function setServiceIconProgress(text) {
  const box = el('serviceIconProgress');
  if (!box) return;
  box.classList.toggle('hidden', !text);
  box.textContent = text || '';
}

artProgressListeners.add((msg) => {
  if (msg.kind !== 'service-icon') return;
  setServiceIconProgress(
    msg.phase === 'sampling' ? `Generating… step ${msg.value}/${msg.max}`
    : msg.phase === 'done' ? 'Finishing up…' : ''
  );
});

el('generateServiceIconBtn').addEventListener('click', async () => {
  const id = state.editingServiceId;
  if (!id || serviceIconBusy) return;
  serviceIconBusy = true;
  renderServiceIconGenerate();
  setServiceIconProgress('Starting… (a few minutes on CPU)');
  try {
    await api.generateServiceIcon(id, el('serviceIconExtra').value.trim());
    await loadAll(); // pull the updated service.iconImage
    el('serviceIconExtra').value = '';
    toast('Icon generated');
  } catch (err) {
    toast(err.message, true);
  } finally {
    serviceIconBusy = false;
    setServiceIconProgress('');
    renderServiceIconGenerate();
  }
});

el('removeServiceIconBtn').addEventListener('click', async () => {
  const id = state.editingServiceId;
  if (!id) return;
  try {
    await api.deleteServiceIcon(id);
    await loadAll();
    renderServiceIconGenerate();
  } catch (err) {
    toast(err.message, true);
  }
});

function closeServiceModal() {
  serviceModal.classList.add('hidden');
  state.editingServiceId = null;
}

el('addServiceBtn').addEventListener('click', () => openServiceModal(null));
el('cancelServiceBtn').addEventListener('click', closeServiceModal);
serviceModal.addEventListener('click', (e) => { if (e.target === serviceModal) closeServiceModal(); });

function buildControllerPayload(fd) {
  const type = fd.get('controllerType');
  if (type === 'docker') {
    return { type: 'docker', container: fd.get('controllerContainer').trim() };
  }
  if (type === 'script') {
    return {
      type: 'script',
      startCmd: fd.get('controllerStartCmd').trim(),
      stopCmd: fd.get('controllerStopCmd').trim(),
      restartCmd: fd.get('controllerRestartCmd').trim(),
    };
  }
  return null;
}

function buildGamePayload(fd) {
  const kind = fd.get('gameKind');
  if (kind === 'minecraft') {
    const payload = {
      kind: 'minecraft',
      rconHost: fd.get('gameRconHost').trim(),
      rconPort: Number(fd.get('gameRconPort')) || 25575,
    };
    const pw = fd.get('gameRconPassword').trim();
    if (pw) payload.rconPassword = pw; // blank → server keeps the saved one
    return payload;
  }
  if (kind === 'fivem') {
    return {
      kind: 'fivem',
      queryUrl: fd.get('gameQueryUrl').trim(),
      txAdminUrl: fd.get('gameTxAdminUrl').trim(),
    };
  }
  return { kind: '' }; // server normalises a kind-less game to null
}

el('pickContainerBtn').addEventListener('click', async () => {
  const listEl = el('containerPickerList');
  const errorEl = el('containerPickerError');
  errorEl.classList.add('hidden');
  listEl.innerHTML = 'Loading…';
  listEl.classList.remove('hidden');
  try {
    const { containers } = await api.getDockerContainers();
    if (!containers.length) {
      listEl.innerHTML = '<p style="color:var(--text-faint);font-size:0.8rem;margin:0;">No containers found.</p>';
      return;
    }
    listEl.innerHTML = containers.map((c) => `
      <label>
        <input type="radio" name="containerPick" value="${escapeAttr(c.name || c.id)}" />
        ${escapeHtml(c.name || c.id)} <span style="color:var(--text-faint);">(${escapeHtml(c.state)})</span>
      </label>
    `).join('');
    listEl.querySelectorAll('input[type=radio]').forEach((radio) => {
      radio.addEventListener('change', () => {
        serviceForm.elements.controllerContainer.value = radio.value;
      });
    });
  } catch (err) {
    listEl.classList.add('hidden');
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

serviceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(serviceForm);
  const payload = {
    name: fd.get('name').trim(),
    url: fd.get('url').trim(),
    icon: fd.get('icon').trim(),
    group: fd.get('group') || null,
    description: fd.get('description').trim(),
    tags: fd.get('tags').split(',').map((t) => t.trim()).filter(Boolean),
    healthCheck: fd.get('healthCheck') === 'on',
    healthCheckPath: fd.get('healthCheckPath').trim() || '/',
    tailscaleHealthCheck: fd.get('tailscaleHealthCheck') === 'on',
    mac: fd.get('mac').trim(),
    controller: buildControllerPayload(fd),
    game: buildGamePayload(fd),
  };

  try {
    let serviceId = state.editingServiceId;
    if (serviceId) {
      await api.updateService(serviceId, payload);
    } else {
      const created = await api.createService(payload);
      serviceId = created.id;
    }

    await syncConnectionsFromChecklist(serviceId);
    closeServiceModal();
    await loadAll();
    toast('Service saved');
  } catch (err) {
    toast(err.message, true);
  }
});

// Only touches connections this service is the editable (non-reverse) side
// of — reverse depends-on rows are removed immediately by their own button
// in populateConnectionsChecklist, not deferred to this save.
async function syncConnectionsFromChecklist(serviceId) {
  const rows = Array.from(el('connectionsChecklist').querySelectorAll('.connection-row'));
  const existingForward = new Map();
  for (const c of state.config.connections) {
    if (c.from === serviceId) existingForward.set(c.to, c);
    else if (c.to === serviceId && c.type === 'related') existingForward.set(c.from, c);
  }

  for (const row of rows) {
    if (row.classList.contains('connection-row-reverse')) continue; // handled by its own remove button
    const otherId = row.dataset.id;
    const type = row.dataset.selected; // '', 'related', or 'depends-on'
    const existing = existingForward.get(otherId);

    if (type) {
      if (!existing) {
        await api.createConnection({ from: serviceId, to: otherId, type });
      } else if (existing.type !== type || (type === 'depends-on' && existing.from !== serviceId)) {
        await api.deleteConnection(existing.id);
        await api.createConnection({ from: serviceId, to: otherId, type });
      }
    } else if (existing) {
      await api.deleteConnection(existing.id);
    }
  }
}

el('deleteServiceBtn').addEventListener('click', async () => {
  if (!state.editingServiceId) return;
  if (!confirm('Delete this service? This also removes its connections.')) return;
  try {
    await api.deleteService(state.editingServiceId);
    closeServiceModal();
    await loadAll();
    toast('Service deleted');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Docker container logs ----------
// Polls a snapshot of the container's recent log buffer every few seconds
// while the modal is open rather than a true live stream (docker logs -f)
// — simpler and doesn't hold a long-lived connection to the Docker socket
// per viewer. Honest tradeoff, called out in the modal's own hint text.
//
// The same modal serves a Docker-backed service (opened from a card) and a
// raw container (opened from the Board's 'docker' widget, ops roadmap Phase
// 2b) — logsTarget carries which, and fetchAndRenderLogs picks the endpoint.

const logsModal = el('logsModal');
let logsPollTimer = null;
let logsTarget = null; // { kind: 'service' | 'container', id, name }

async function fetchAndRenderLogs() {
  if (!logsTarget) return;
  const output = el('logsOutput');
  try {
    const { logs } = logsTarget.kind === 'container'
      ? await api.getContainerLogs(logsTarget.name)
      : await api.getServiceLogs(logsTarget.id);
    const wasAtBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
    output.textContent = logs || '(no output yet)';
    if (wasAtBottom) output.scrollTop = output.scrollHeight;
    el('logsError').classList.add('hidden');
  } catch (err) {
    el('logsError').textContent = err.message;
    el('logsError').classList.remove('hidden');
  }
}

const LOGS_POLL_MS = 4000;

function openLogsModal(service) {
  openLogsFor({ kind: 'service', id: service.id, name: service.name });
}

function openLogsFor(target) {
  logsTarget = target;
  el('logsModalTitle').textContent = `${target.name} — logs`;
  el('logsOutput').textContent = 'Loading…';
  el('logsError').classList.add('hidden');
  logsModal.classList.remove('hidden');
  fetchAndRenderLogs();
  clearInterval(logsPollTimer);
  logsPollTimer = setInterval(fetchAndRenderLogs, LOGS_POLL_MS);
}

function closeLogsModal() {
  logsModal.classList.add('hidden');
  clearInterval(logsPollTimer);
  logsPollTimer = null;
  logsTarget = null;
}

el('refreshLogsBtn').addEventListener('click', fetchAndRenderLogs);
el('closeLogsBtn').addEventListener('click', closeLogsModal);
logsModal.addEventListener('click', (e) => { if (e.target === logsModal) closeLogsModal(); });

// ---------- Game server console (creative roadmap Phase 5) ----------
// A player-list line (polled) plus a command box that runs over RCON. The
// command endpoint is gated server-side (Service Control switch + password);
// this shows the gate state rather than hiding the box.

const gameConsoleModal = el('gameConsoleModal');
let gameConsoleServiceId = null;
let gameConsoleKind = null;
let gamePlayersPollTimer = null;
const GAME_PLAYERS_POLL_MS = 5000;

async function refreshGamePlayers() {
  if (!gameConsoleServiceId) return;
  const info = el('gameServerInfo');
  const box = el('gamePlayers');
  try {
    const s = await api.gameServerStatus(gameConsoleServiceId);
    if (!s.online) {
      info.classList.add('hidden');
      box.innerHTML = `<span class="game-players-off">⚠ ${escapeHtml(s.error || 'unreachable')}</span>`;
      return;
    }
    // server-info line — FiveM has one, Minecraft doesn't
    const bits = [s.serverName, s.gametype, s.mapName, s.build && `build ${s.build}`,
      s.resourceCount != null && `${s.resourceCount} resources`].filter(Boolean);
    info.classList.toggle('hidden', !bits.length);
    if (bits.length) info.textContent = bits.join(' · ');

    const n = s.count ?? s.players?.length ?? 0;
    const players = (s.players || []).map((p) =>
      typeof p === 'string'
        ? `<span class="game-player">${escapeHtml(p)}</span>`
        : `<span class="game-player">${escapeHtml(p.name)}${p.ping != null ? ` <em>${p.ping}ms</em>` : ''}</span>`
    ).join('');
    box.innerHTML = `<strong>${n}${s.max != null ? ` / ${s.max}` : ''} online</strong>${players ? ` ${players}` : ''}`;
  } catch (err) {
    info.classList.add('hidden');
    box.innerHTML = `<span class="game-players-off">⚠ ${escapeHtml(err.message)}</span>`;
  }
}

function appendGameOutput(line) {
  const out = el('gameConsoleOutput');
  out.textContent += (out.textContent ? '\n' : '') + line;
  out.scrollTop = out.scrollHeight;
}

function openGameConsole(service) {
  gameConsoleServiceId = service.id;
  gameConsoleKind = service.game?.kind || null;
  const isMc = gameConsoleKind === 'minecraft';

  el('gameConsoleTitle').textContent = `${service.name} — ${isMc ? 'console' : 'game server'}`;
  el('gameConsoleOutput').textContent = '';
  el('gameConsoleOutput').classList.toggle('hidden', !isMc);
  el('gameConsoleForm').classList.toggle('hidden', !isMc);
  el('gameConsoleError').classList.add('hidden');
  el('gameServerInfo').classList.add('hidden');
  el('gamePlayers').textContent = 'Loading…';
  el('gameConsoleInput').value = '';

  const txUrl = service.game?.txAdminUrl;
  const link = el('gameTxAdminLink');
  link.classList.toggle('hidden', !txUrl);
  if (txUrl) link.href = txUrl;

  if (isMc) {
    const canRun = !!state.config.security?.serviceControl?.enabled;
    el('gameConsoleInput').disabled = !canRun;
    el('gameConsoleForm').querySelector('button').disabled = !canRun;
    el('gameConsoleHint').textContent = canRun
      ? 'Commands run over RCON on the server.'
      : 'Turn on Service Control (Settings → Security) to run commands.';
  } else {
    el('gameConsoleHint').textContent = 'Read-only. Restart and console are in txAdmin.';
  }

  gameConsoleModal.classList.remove('hidden');
  refreshGamePlayers();
  clearInterval(gamePlayersPollTimer);
  gamePlayersPollTimer = setInterval(refreshGamePlayers, GAME_PLAYERS_POLL_MS);
}

function closeGameConsole() {
  gameConsoleModal.classList.add('hidden');
  clearInterval(gamePlayersPollTimer);
  gamePlayersPollTimer = null;
  gameConsoleServiceId = null;
}

el('gameConsoleClose').addEventListener('click', closeGameConsole);
gameConsoleModal.addEventListener('click', (e) => { if (e.target === gameConsoleModal) closeGameConsole(); });

el('gameConsoleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el('gameConsoleInput');
  const command = input.value.trim();
  if (!command || !gameConsoleServiceId) return;
  appendGameOutput(`> ${command}`);
  input.value = '';
  el('gameConsoleError').classList.add('hidden');
  try {
    const { output } = await api.gameServerCommand(gameConsoleServiceId, command);
    appendGameOutput(output || '(no output)');
  } catch (err) {
    el('gameConsoleError').textContent = err.message;
    el('gameConsoleError').classList.remove('hidden');
  }
  refreshGamePlayers();
});
