import { api } from './api.js';
import { drawConnectionLines, buildAdjacency, highlightNeighbors, clearHighlight } from './connections.js';
import { connectWebSocket } from './ws.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

const state = {
  config: null,
  status: new Map(),
  activeGroup: null,
  search: '',
  connectionsVisible: false,
  editingServiceId: null,
  filesPath: '',
  notificationsEnabled: localStorage.getItem('mc:notificationsEnabled') === 'true',
  theme: localStorage.getItem('mc:theme') || 'dark',
  deviceName: ensureDeviceName(),
  activeChannelId: null,
  chatMessages: new Map(),
  chatUnseen: 0,
  highlightedServiceId: null,
  revealedUrls: new Set(),
  revealedDeviceIps: new Set(),
  dashboardViewMode: localStorage.getItem('mc:dashboardView') || 'card', // per-device only — never synced, never in config.json
  filesViewMode: localStorage.getItem('mc:filesView') || 'list',
  // 'tabs' (channels above, today's layout) | 'sidebar' (channel list
  // beside the conversation) | 'floating' (borderless bubbles over the
  // page). Guards against a stale 'default'/'bubbles'/'compact' value
  // from before these were whole-layout switches, not just message styles.
  chatViewMode: ['tabs', 'sidebar', 'floating'].includes(localStorage.getItem('mc:chatView'))
    ? localStorage.getItem('mc:chatView')
    : 'tabs',
  settingsTab: localStorage.getItem('mc:settingsTab') || 'appearance',
};

const cardsById = new Map();
const graphNodesById = new Map();

const el = (id) => document.getElementById(id);
const svgOverlay = el('connectionsOverlay');
const gridWrap = el('gridWrap');
const cardGrid = el('cardGrid');
const pinnedGrid = el('pinnedGrid');

function toast(message, isError = false) {
  const t = el('toast');
  t.textContent = message;
  t.classList.remove('hidden');
  t.style.borderColor = isError ? 'var(--offline)' : 'var(--border)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// navigator.clipboard only exists in a secure context (https:// or
// localhost) — a device opening this over a plain-HTTP LAN address (the
// normal way to reach this app from a phone) doesn't have it at all, so
// the modern API silently fails there. This falls back to the old
// execCommand trick, which has no such restriction.
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy command was blocked');
  } finally {
    document.body.removeChild(textarea);
  }
}

// ---------- Data loading ----------

async function loadAll() {
  const [config, status] = await Promise.all([api.getConfig(), api.getStatus()]);
  state.config = config;
  applyStatus(status.services);
  render();
}

function applyStatus(list) {
  for (const s of list) state.status.set(s.id, s);
}

// Shared by both the REST poll and the WebSocket push so a status change
// only ever gets diffed/notified/rendered once, regardless of which
// transport delivered it first.
function applyIncomingStatus(list) {
  const prev = new Map(Array.from(state.status.entries()).map(([id, s]) => [id, s.status]));
  applyStatus(list);
  handleStatusTransitions(prev);
  renderCardStatuses();
}

async function pollStatus() {
  try {
    const status = await api.getStatus();
    applyIncomingStatus(status.services);
  } catch {
    // transient network hiccup — next poll will retry
  }
}

// Real-time sync: every connected device pushes and receives the same
// config/status/chat changes over one shared WebSocket connection.
// The 5s REST poll stays in place as a fallback in case a socket never
// connects or is mid-reconnect — see the "Render + boot" section at the
// bottom for where this actually gets wired up and started.
function handleWsStatus(msg) {
  applyIncomingStatus(msg.services);
}

function handleWsConfig(msg) {
  if (dragOriginContainer) return; // don't yank a card out from under an active drag; the next update will reconcile
  state.config = msg.config;
  render();

  if (el('chatView').classList.contains('active')) {
    const stillExists = (state.config.chatChannels || []).some((c) => c.id === state.activeChannelId);
    if (!stillExists) {
      const first = (state.config.chatChannels || [])[0];
      if (first) switchChannel(first.id);
    } else {
      renderChatChannels();
    }
  }
}

function handleWsChatMessage(msg) {
  const list = state.chatMessages.get(msg.channelId) || [];
  list.push(msg.message);
  state.chatMessages.set(msg.channelId, list);
  if (el('chatView').classList.contains('active') && state.activeChannelId === msg.channelId) {
    renderChatMessages();
  } else {
    state.chatUnseen += 1;
    renderChatBadge();
  }
}

function handleWsChatMessageDeleted(msg) {
  const list = state.chatMessages.get(msg.channelId) || [];
  state.chatMessages.set(msg.channelId, list.filter((m) => m.id !== msg.messageId));
  if (el('chatView').classList.contains('active') && state.activeChannelId === msg.channelId) {
    renderChatMessages();
  }
}

// Diffs each service's status against what it was on the previous poll and
// fires a notification on an online<->offline transition. Ignores
// 'checking'/'unmonitored' states so a freshly-added service or a first
// completed check never spams a notification.
function handleStatusTransitions(prevMap) {
  const trackable = new Set(['online', 'offline']);
  for (const service of state.config.services) {
    const prevStatus = prevMap.get(service.id);
    const newStatus = state.status.get(service.id)?.status;
    if (!trackable.has(prevStatus) || !trackable.has(newStatus)) continue;
    if (prevStatus === newStatus) continue;
    notifyStatusChange(service, newStatus);
  }
}

function notifyStatusChange(service, newStatus) {
  const message = newStatus === 'online' ? `${service.name} is back online` : `${service.name} went offline`;
  toast(message, newStatus === 'offline');
  if (state.notificationsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(message, { body: service.url, tag: `mc-${service.id}` });
  }
}

// ---------- View switching ----------

el('viewSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  for (const b of el('viewSwitch').querySelectorAll('button')) b.classList.remove('active');
  btn.classList.add('active');
  const view = btn.dataset.view;
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  el(`${view}View`).classList.add('active');
  // Search/Connections/Discover all act on the service grid — dead
  // controls on Files/Chat, so they only take up toolbar space on
  // Dashboard.
  el('toolbarDashboardControls').classList.toggle('hidden', view !== 'dashboard');
  if (view === 'files') renderFiles();
  if (view === 'chat') {
    state.chatUnseen = 0;
    renderChatBadge();
    if (!state.activeChannelId) {
      const first = (state.config.chatChannels || [])[0];
      if (first) switchChannel(first.id);
    } else {
      renderChatChannels();
      renderChatMessages();
    }
  }
});

// ---------- Group filters ----------

function renderGroupFilters() {
  const wrap = el('groupFilters');
  wrap.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = 'group-chip' + (state.activeGroup === null ? ' active' : '');
  allChip.textContent = 'All';
  allChip.onclick = () => { state.activeGroup = null; render(); };
  wrap.appendChild(allChip);

  for (const g of state.config.groups) {
    const chip = document.createElement('button');
    chip.className = 'group-chip' + (state.activeGroup === g.id ? ' active' : '');
    chip.innerHTML = `<span class="dot" style="background:${g.color}"></span>${g.name}`;
    chip.onclick = () => { state.activeGroup = g.id; render(); };
    wrap.appendChild(chip);
  }
}

el('search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderCards();
});

// ---------- Cards ----------

function groupById(id) {
  return state.config.groups.find((g) => g.id === id) || null;
}

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
  if (status.status === 'online') return { cls: 'online', text: `online · ${status.latencyMs}ms` };
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

const UPTIME_SAMPLES = 30;

function renderUptimeStrip(card, status) {
  const history = status?.history || [];
  const padCount = Math.max(0, UPTIME_SAMPLES - history.length);
  const bars = Array(padCount).fill('none').concat(history);
  card.querySelector('.uptime-strip').innerHTML = bars.map((h) => `<span class="uptime-bar ${h}"></span>`).join('');
  card.querySelector('.uptime-percent').textContent = status?.uptimePercent != null ? `${status.uptimePercent}%` : '—';
}

function buildCardElement(service, adjacency) {
  const group = groupById(service.group);
  const status = state.status.get(service.id);
  const sl = statusLabel(status);
  const connectionCount = (adjacency.get(service.id) || new Set()).size;

  const favicon = service.icon ? null : faviconUrl(service.url);
  const iconMarkup = service.icon
    ? `<div class="card-icon">${escapeHtml(service.icon)}</div>`
    : favicon
      ? `<img class="card-favicon" alt="" src="${escapeAttr(favicon)}" />`
      : `<div class="card-icon">🔗</div>`;

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
    dragOriginContainer = card.parentElement;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', service.id); // required by Firefox to start a drag
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragOriginContainer = null;
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
  if (mode !== 'card') el('pinnedSection').classList.add('hidden');
  svgOverlay.classList.toggle('visible', mode === 'card' && state.connectionsVisible);
}

function renderCards() {
  setDashboardLayoutVisibility(state.dashboardViewMode);
  if (state.dashboardViewMode === 'list') renderServicesListView();
  else if (state.dashboardViewMode === 'graph') renderServicesGraphView();
  else renderServicesCardView();
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
  if (service.icon) return escapeHtml(service.icon);
  const url = faviconUrl(service.url);
  return url ? `<img src="${escapeAttr(url)}" alt="" />` : '🔗';
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
  const radius = Math.max(60, Math.min(cx, cy) - 70);

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

function renderCardStatuses() {
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

function renderOnlineBadge() {
  const total = state.config.services.length;
  const online = state.config.services.filter((s) => state.status.get(s.id)?.status === 'online').length;
  const badge = el('onlineBadge');
  badge.textContent = `${online}/${total}`;
  badge.title = `${online} of ${total} services online`;
}

function renderConnectionOverlay() {
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
      localStorage.setItem('mc:seenConnectionsHint', 'true');
    }
  }
});

el('dashboardLayoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  state.dashboardViewMode = btn.dataset.layout;
  localStorage.setItem('mc:dashboardView', state.dashboardViewMode);
  el('dashboardLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  renderCards();
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

// ---------- Drag-to-reorder ----------
// Pinned and regular cards reorder independently within their own grid —
// dragging never moves a card between sections (that's what the pin star
// is for). dragOriginContainer scopes each drag to the grid it started in.

let dragOriginContainer = null;

function getDragTarget(container, x, y, selector = '.service-card') {
  const cards = [...container.querySelectorAll(`${selector}:not(.dragging)`)];

  // Prefer an exact match: same row as the cursor, left half of the card.
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    if (y >= box.top && y <= box.bottom && x < box.left + box.width / 2) {
      return card;
    }
  }

  // Otherwise fall back to the nearest card overall and insert after it.
  let nearest = null;
  let nearestDist = Infinity;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dist = (x - cx) ** 2 + (y - cy) ** 2;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = card;
    }
  }
  return nearest ? nearest.nextElementSibling : null;
}

function applyLocalReorder(ids) {
  const byId = new Map(state.config.services.map((s) => [s.id, s]));
  const idSet = new Set(ids);
  let cursor = 0;
  state.config.services = state.config.services.map((s) => (idSet.has(s.id) ? byId.get(ids[cursor++]) : s));
}

// Generic drag-to-reorder for any flat list of elements with a data-id —
// used for both the service card grids and the chat channel tabs below.
// itemSelector picks which children count as draggable rows; reorder(ids)
// persists the new order server-side; onSuccess/onError update local state
// to match (or resync from the server if the request failed).
function enableDragReorder(container, { itemSelector = '.service-card', reorder, onSuccess, onError } = {}) {
  container.addEventListener('dragover', (e) => {
    if (dragOriginContainer !== container) return;
    e.preventDefault();
    const dragging = container.querySelector('.dragging');
    if (!dragging) return;
    const target = getDragTarget(container, e.clientX, e.clientY, itemSelector);
    if (target == null) {
      container.appendChild(dragging);
    } else if (target !== dragging) {
      container.insertBefore(dragging, target);
    }
  });

  container.addEventListener('drop', async (e) => {
    if (dragOriginContainer !== container) return;
    e.preventDefault();
    const ids = Array.from(container.querySelectorAll(itemSelector)).map((c) => c.dataset.id);
    try {
      await reorder(ids);
      onSuccess?.(ids);
    } catch (err) {
      toast(err.message, true);
      await onError?.();
    }
  });
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

window.addEventListener('resize', () => {
  if (state.dashboardViewMode === 'card' && state.connectionsVisible) renderConnectionOverlay();
  if (state.dashboardViewMode === 'graph') renderServicesGraphView();
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// ---------- Add/Edit service modal ----------

const serviceModal = el('serviceModal');
const serviceForm = el('serviceForm');

// Local/private addresses are worth polling for uptime; a public website
// bookmark usually isn't — this just sets a sensible starting point for the
// checkbox when adding a new entry, the user can always override it.
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

serviceForm.elements.url.addEventListener('input', () => {
  if (state.editingServiceId) return; // don't second-guess an explicit edit
  serviceForm.elements.healthCheck.checked = isLocalUrl(serviceForm.elements.url.value);
});

function populateGroupSelect() {
  const select = el('serviceGroupSelect');
  select.innerHTML = '<option value="">No group</option>' +
    state.config.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
}

function populateConnectionsChecklist(currentId) {
  const wrap = el('connectionsChecklist');
  const others = state.config.services.filter((s) => s.id !== currentId);
  const adjacency = buildAdjacency(state.config.connections);
  const connected = currentId ? adjacency.get(currentId) || new Set() : new Set();

  if (others.length === 0) {
    wrap.innerHTML = '<p style="color:var(--text-faint);font-size:0.8rem;margin:0;">Add more services to connect them.</p>';
    return;
  }

  wrap.innerHTML = others.map((s) => `
    <label>
      <input type="checkbox" value="${s.id}" ${connected.has(s.id) ? 'checked' : ''} />
      ${s.icon || ''} ${escapeHtml(s.name)}
    </label>
  `).join('');
}

function openServiceModal(serviceId = null, prefill = null) {
  state.editingServiceId = serviceId;
  populateGroupSelect();
  serviceForm.reset();
  el('serviceForm').elements.healthCheck.checked = true;
  el('deleteServiceBtn').classList.toggle('hidden', !serviceId);

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
    serviceForm.elements.mac.value = s.mac || '';
  } else {
    el('serviceModalTitle').textContent = 'Add Service';
    serviceForm.elements.healthCheckPath.value = '/';
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

  populateConnectionsChecklist(serviceId);
  serviceModal.classList.remove('hidden');
}

function closeServiceModal() {
  serviceModal.classList.add('hidden');
  state.editingServiceId = null;
}

el('addServiceBtn').addEventListener('click', () => openServiceModal(null));
el('cancelServiceBtn').addEventListener('click', closeServiceModal);
serviceModal.addEventListener('click', (e) => { if (e.target === serviceModal) closeServiceModal(); });

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
    mac: fd.get('mac').trim(),
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

async function syncConnectionsFromChecklist(serviceId) {
  const checked = new Set(
    Array.from(el('connectionsChecklist').querySelectorAll('input[type=checkbox]:checked')).map((c) => c.value)
  );
  const adjacency = buildAdjacency(state.config.connections);
  const existing = adjacency.get(serviceId) || new Set();

  const toAdd = [...checked].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !checked.has(id));

  await Promise.all(toAdd.map((otherId) => api.createConnection({ from: serviceId, to: otherId })));

  for (const otherId of toRemove) {
    const conn = state.config.connections.find(
      (c) => (c.from === serviceId && c.to === otherId) || (c.from === otherId && c.to === serviceId)
    );
    if (conn) await api.deleteConnection(conn.id);
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

// ---------- Theme ----------

const THEMES = [
  { id: 'dark', name: 'Dark', bg: '#0d0f14', accent: '#7c5cff' },
  { id: 'light', name: 'Light', bg: '#f4f5f8', accent: '#6d4aff' },
  { id: 'cyberpunk', name: 'Cyberpunk', bg: '#08060f', accent: '#ff2079' },
  { id: 'pride', name: 'Pride', bg: '#121016', accent: '#ff4d9e' },
  { id: 'cute', name: 'Cute', bg: '#fdf3f8', accent: '#ff8fc7' },
  { id: 'cozy', name: 'Cozy', bg: '#241a14', accent: '#e08540' },
  { id: 'her', name: 'Her', bg: '#2b1a24', accent: '#ff6fa8' },
  { id: 'forest', name: 'Forest', bg: '#0f1710', accent: '#43a047' },
  { id: 'ocean', name: 'Ocean', bg: '#071620', accent: '#22b8cf' },
  { id: 'matrix', name: 'Matrix', bg: '#000502', accent: '#00ff41' },
  { id: 'nord', name: 'Nord', bg: '#2e3440', accent: '#88c0d0' },
  { id: 'sunset', name: 'Sunset', bg: '#1a0f1f', accent: '#ff7e5f' },
  { id: 'vaporwave', name: 'Vaporwave', bg: '#100a24', accent: '#ff71ce' },
  { id: 'mono', name: 'Mono', bg: '#121212', accent: '#ffffff' },
];

function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  localStorage.setItem('mc:theme', themeId);
  state.theme = themeId;
  renderThemeGrid();
  if (state.connectionsVisible) requestAnimationFrame(renderConnectionOverlay);
}

function renderThemeGrid() {
  const wrap = el('themeGrid');
  wrap.innerHTML = THEMES.map((t) => `
    <button type="button" class="theme-swatch ${state.theme === t.id ? 'active' : ''}" data-theme-id="${t.id}">
      <span class="theme-swatch-preview" style="background:${t.bg}">
        <span class="theme-swatch-dot" style="background:${t.accent};color:${t.accent}"></span>
      </span>
      <span>${t.name}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('.theme-swatch').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeId));
  });
}

renderThemeGrid();

// ---------- Settings modal ----------

const settingsModal = el('settingsModal');

function renderGroupsList() {
  const wrap = el('groupsList');
  wrap.innerHTML = state.config.groups.map((g) => `
    <div class="group-row" data-id="${g.id}">
      <span class="dot" style="background:${g.color}"></span>
      <span class="name">${escapeHtml(g.name)}</span>
      <button data-action="delete-group" title="Delete group">✕</button>
    </div>
  `).join('') || '<p style="color:var(--text-faint);font-size:0.85rem;">No groups yet.</p>';

  wrap.querySelectorAll('[data-action="delete-group"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.group-row').dataset.id;
      if (!confirm('Delete this group? Services stay, just ungrouped.')) return;
      try {
        await api.deleteGroup(id);
        await loadAll();
        renderGroupsList();
        toast('Group deleted');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// Device list is fetched fresh on open and refreshed on a short poll only
// while the modal is actually visible — no point tracking a timer in the
// background for a panel nobody's looking at.
let settingsPollTimer = null;

function renderDevicesList(devices) {
  const wrap = el('devicesList');
  if (!devices.length) {
    wrap.innerHTML = '<p style="color:var(--text-faint);font-size:0.85rem;margin:0;">No devices recorded yet.</p>';
    return;
  }
  wrap.innerHTML = devices.map((d) => {
    const ipRevealed = state.revealedDeviceIps.has(d.ip);
    const ipLabel = ipRevealed ? escapeHtml(d.ip) : '🔒 tap to reveal';
    return `
      <div class="device-row">
        <span class="status-dot ${d.online ? 'online' : 'unmonitored'}" title="${d.online ? 'Connected right now' : 'Not currently connected'}"></span>
        <div class="device-info">
          <div class="device-label">${escapeHtml(d.label)}</div>
          <div class="device-meta"><button type="button" class="device-ip-toggle" data-ip="${escapeAttr(d.ip)}">${ipLabel}</button> · last seen ${timeAgo(d.lastSeen)} · ${d.requestCount} request${d.requestCount === 1 ? '' : 's'}</div>
        </div>
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('.device-ip-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ip = btn.dataset.ip;
      if (state.revealedDeviceIps.has(ip)) {
        state.revealedDeviceIps.delete(ip);
        btn.textContent = '🔒 tap to reveal';
      } else {
        state.revealedDeviceIps.add(ip);
        btn.textContent = ip;
      }
    });
  });
}

async function loadAndRenderDevices() {
  try {
    const { devices } = await api.getDevices();
    renderDevicesList(devices);
  } catch (err) {
    toast(err.message, true);
  }
}

function healthBarClass(percent) {
  if (percent >= 85) return 'offline';
  if (percent >= 60) return 'checking';
  return 'online';
}

function formatGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

// Renders the full breakdown into whichever element id is passed in — used
// by both the standalone Host Health modal (see below) and, previously,
// the now-removed Settings section, kept parametrized in case a second
// full view ever wants it again.
function renderHostHealth(targetId, h) {
  const wrap = el(targetId);
  if (!h) {
    wrap.innerHTML = '<p style="color:var(--text-faint);font-size:0.85rem;margin:0;">Host stats unavailable.</p>';
    return;
  }

  const memPercent = Math.round((h.memory.used / h.memory.total) * 100);
  const diskPercent = h.disk ? Math.round((h.disk.used / h.disk.total) * 100) : null;

  wrap.innerHTML = `
    <div class="host-stat">
      <div class="host-stat-label">CPU <span>${h.cpuPercent}%</span></div>
      <div class="host-bar"><div class="host-bar-fill ${healthBarClass(h.cpuPercent)}" style="width:${h.cpuPercent}%"></div></div>
    </div>
    <div class="host-stat">
      <div class="host-stat-label">Memory <span>${formatGB(h.memory.used)} / ${formatGB(h.memory.total)}</span></div>
      <div class="host-bar"><div class="host-bar-fill ${healthBarClass(memPercent)}" style="width:${memPercent}%"></div></div>
    </div>
    ${h.disk ? `
    <div class="host-stat">
      <div class="host-stat-label">Disk (${escapeHtml(h.disk.path)}) <span>${formatGB(h.disk.used)} / ${formatGB(h.disk.total)}</span></div>
      <div class="host-bar"><div class="host-bar-fill ${healthBarClass(diskPercent)}" style="width:${diskPercent}%"></div></div>
    </div>` : ''}
    <div class="host-meta">
      ${escapeHtml(h.hostname)} · ${escapeHtml(h.platform)} (${escapeHtml(h.arch)}) · ${escapeHtml(h.cpuModel)} · ${h.cpuCount} cores · up ${formatUptime(h.uptimeSeconds)}
    </div>
  `;
}

// The always-visible hero pill — shows just the CPU figure (the single
// number people actually glance at) color-coded to the same thresholds as
// the full bars, so a problem is visible without opening anything.
function renderHostHealthQuick(h) {
  const btn = el('openHostHealth');
  btn.classList.remove('online', 'checking', 'offline');
  if (!h) {
    btn.textContent = '🖥️ …';
    return;
  }
  btn.textContent = `🖥️ ${h.cpuPercent}%`;
  btn.classList.add(healthBarClass(h.cpuPercent));
  btn.title = `Host PC Health — CPU ${h.cpuPercent}%`;
}

// One poll loop, always running (started in the boot section below) —
// the hero pill needs live data on every tab regardless of whether the
// modal is open, and the modal (when it is open) just piggybacks on the
// same 5s tick instead of running a second timer alongside it.
let lastHostHealth = null;

async function pollHostHealth() {
  try {
    lastHostHealth = await api.getHostHealth();
  } catch {
    lastHostHealth = null;
  }
  renderHostHealthQuick(lastHostHealth);
  if (!hostHealthModal.classList.contains('hidden')) {
    renderHostHealth('hostHealthFull', lastHostHealth);
  }
}

const hostHealthModal = el('hostHealthModal');

function openHostHealthModal() {
  hostHealthModal.classList.remove('hidden');
  renderHostHealth('hostHealthFull', lastHostHealth);
}

function closeHostHealthModal() {
  hostHealthModal.classList.add('hidden');
}

el('openHostHealth').addEventListener('click', openHostHealthModal);
el('closeHostHealthBtn').addEventListener('click', closeHostHealthModal);
hostHealthModal.addEventListener('click', (e) => { if (e.target === hostHealthModal) closeHostHealthModal(); });

// ---------- Security (password gate) ----------
// state.config.auth only ever carries { enabled } — the server strips the
// salt/hash before this ever reaches a browser (see config.js
// sanitizeConfig), so there's nothing sensitive to guard client-side here.

function renderAuthSection() {
  const enabled = state.config.auth.enabled;
  el('authStatusText').textContent = enabled
    ? '🔒 Password protection is ON for this app.'
    : '🔓 Password protection is OFF — anyone who can reach this server has full access.';
  el('setPasswordBtn').textContent = enabled ? 'Change password' : 'Set password & enable';
  el('disableAuthBtn').classList.toggle('hidden', !enabled);
  el('logoutBtn').classList.toggle('hidden', !enabled);
  el('setPasswordForm').reset();
  el('passwordError').classList.add('hidden');
  el('sessionDaysInput').value = state.config.auth.sessionDays;
  el('ipAllowlistEnabled').checked = state.config.security.ipAllowlist.enabled;
  el('ipAllowlistSubnets').value = state.config.security.ipAllowlist.subnets.join('\n');
  el('ipAllowlistError').classList.add('hidden');
}

el('saveIpAllowlistBtn').addEventListener('click', async () => {
  const errorEl = el('ipAllowlistError');
  errorEl.classList.add('hidden');
  const subnets = el('ipAllowlistSubnets').value.split('\n').map((s) => s.trim()).filter(Boolean);

  try {
    await api.updateSettings({
      security: { ipAllowlist: { enabled: el('ipAllowlistEnabled').checked, subnets } },
    });
    await loadAll();
    renderAuthSection();
    toast('IP allowlist saved');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

el('saveSessionDaysBtn').addEventListener('click', async () => {
  const days = Number(el('sessionDaysInput').value);
  try {
    await api.setSessionLength(days);
    await loadAll();
    toast('Session length saved');
  } catch (err) {
    toast(err.message, true);
  }
});

el('setPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = el('passwordError');
  errorEl.classList.add('hidden');
  const fd = new FormData(e.target);
  const password = fd.get('password');
  const confirm = fd.get('confirm');

  if (password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (password !== confirm) {
    errorEl.textContent = "Passwords don't match.";
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    await api.setPassword(password);
    await loadAll();
    renderAuthSection();
    toast('Password protection enabled');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

el('disableAuthBtn').addEventListener('click', async () => {
  if (!confirm('Disable password protection? Anyone who can reach this server will have full access again.')) return;
  try {
    await api.disableAuth();
    await loadAll();
    renderAuthSection();
    toast('Password protection disabled');
  } catch (err) {
    toast(err.message, true);
  }
});

el('logoutBtn').addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    // even if the request fails, still send the browser to the login page
  }
  window.location.href = '/login.html';
});

// ---------- Settings tabs ----------
// Per-device only (localStorage), same as the dashboard/files/chat layout
// switchers — which department you were last looking at isn't something
// worth syncing across devices.

function applySettingsTab(tab) {
  state.settingsTab = tab;
  localStorage.setItem('mc:settingsTab', tab);
  el('settingsTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.settings-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tabPanel === tab));
}

el('settingsTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  applySettingsTab(btn.dataset.tab);
});

function openSettingsModal() {
  renderGroupsList();
  el('notifyToggle').checked = state.notificationsEnabled;
  el('intervalInput').value = Math.round(state.config.settings.healthCheckIntervalMs / 1000);
  el('timeoutInput').value = Math.round(state.config.settings.healthCheckTimeoutMs / 1000);
  el('sharedEnabled').checked = state.config.sharedFolder.enabled;
  el('sharedPath').value = state.config.sharedFolder.path;
  el('sharedAllowUpload').checked = state.config.sharedFolder.allowUpload;
  el('sharedAllowDelete').checked = state.config.sharedFolder.allowDelete;
  el('alertsEnabled').checked = state.config.alerts.enabled;
  el('alertsWebhookUrl').value = state.config.alerts.webhookUrl;
  el('alertsFormat').value = state.config.alerts.format;
  renderAuthSection();
  applySettingsTab(state.settingsTab);
  settingsModal.classList.remove('hidden');
  loadAndRenderDevices();
  settingsPollTimer = setInterval(loadAndRenderDevices, 5000);
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
  clearInterval(settingsPollTimer);
  settingsPollTimer = null;
}

el('notifyToggle').addEventListener('change', async (e) => {
  const checkbox = e.target;
  if (checkbox.checked) {
    if (typeof Notification === 'undefined') {
      toast('Desktop notifications are not supported in this browser', true);
      checkbox.checked = false;
      return;
    }
    // Notification.requestPermission() silently auto-denies on a plain
    // HTTP LAN address (only https:// or localhost qualify) — checking
    // this first gives an actionable reason instead of the generic
    // "permission not granted" a device would otherwise get for something
    // that was never actually offered to them.
    if (!window.isSecureContext) {
      toast('Desktop notifications need HTTPS or localhost — this device is on a plain LAN address, so only in-page toasts will show', true);
      checkbox.checked = false;
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notification permission was not granted', true);
      checkbox.checked = false;
      return;
    }
  }
  state.notificationsEnabled = checkbox.checked;
  localStorage.setItem('mc:notificationsEnabled', String(checkbox.checked));
});

el('openSettings').addEventListener('click', openSettingsModal);
el('closeSettingsBtn').addEventListener('click', closeSettingsModal);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettingsModal(); });

el('sendTestAlertBtn').addEventListener('click', async () => {
  const btn = el('sendTestAlertBtn');
  const webhookUrl = el('alertsWebhookUrl').value.trim();
  if (!webhookUrl) {
    toast('Enter a webhook URL first', true);
    return;
  }
  // Tests against whatever is currently *saved*, not the unsaved form
  // field — save first if the URL was just typed in, otherwise this would
  // silently test the old one.
  btn.disabled = true;
  try {
    await api.updateSettings({ alerts: { enabled: el('alertsEnabled').checked, webhookUrl, format: el('alertsFormat').value } });
    await api.testAlert();
    toast('Test alert sent — check your webhook destination');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Config export/import ----------
// Export is a plain link (server sets Content-Disposition), so there's
// nothing to wire up for it beyond the href already in the markup. Import
// reads the file client-side and posts the parsed JSON — a wholesale
// replace, so this is the one confirm() in Settings guarding something
// that can't be undone without a backup of its own.

el('importConfigBtn').addEventListener('click', () => el('importConfigInput').click());

el('importConfigInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast('That file isn\'t valid JSON', true);
    return;
  }

  if (!confirm('Import this config? It replaces every service, group, connection, and chat channel currently configured — for every device, not just this one. This can\'t be undone unless you have your own backup.')) {
    return;
  }

  try {
    const result = await api.importConfig(parsed);
    closeSettingsModal();
    await loadAll();
    toast(`Imported ${result.serviceCount} service${result.serviceCount === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message, true);
  }
});

el('clearDevicesBtn').addEventListener('click', async () => {
  if (!confirm('Clear device history? Devices currently connected stay listed.')) return;
  try {
    await api.clearDevices();
    loadAndRenderDevices();
  } catch (err) {
    toast(err.message, true);
  }
});

el('addGroupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api.createGroup({ name: fd.get('name').trim(), color: fd.get('color') });
    e.target.reset();
    await loadAll();
    renderGroupsList();
  } catch (err) {
    toast(err.message, true);
  }
});

el('saveSettingsBtn').addEventListener('click', async () => {
  try {
    await api.updateSettings({
      settings: {
        healthCheckIntervalMs: Number(el('intervalInput').value) * 1000,
        healthCheckTimeoutMs: Number(el('timeoutInput').value) * 1000,
      },
      sharedFolder: {
        enabled: el('sharedEnabled').checked,
        path: el('sharedPath').value.trim(),
        allowUpload: el('sharedAllowUpload').checked,
        allowDelete: el('sharedAllowDelete').checked,
      },
      alerts: {
        enabled: el('alertsEnabled').checked,
        webhookUrl: el('alertsWebhookUrl').value.trim(),
        format: el('alertsFormat').value,
      },
    });
    closeSettingsModal();
    await loadAll();
    toast('Settings saved');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Files view ----------

function renderBreadcrumbs() {
  const wrap = el('breadcrumbs');
  const parts = state.filesPath.split('/').filter(Boolean);
  wrap.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.textContent = '📁 shared';
  rootBtn.onclick = () => { state.filesPath = ''; renderFiles(); };
  wrap.appendChild(rootBtn);

  let acc = '';
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    const sep = document.createElement('span');
    sep.textContent = '/';
    wrap.appendChild(sep);
    const btn = document.createElement('button');
    btn.textContent = part;
    const target = acc;
    btn.onclick = () => { state.filesPath = target; renderFiles(); };
    wrap.appendChild(btn);
  }
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

// ---------- Files layout switcher (List / Thumbnail / Tree) ----------
// Per-device only (localStorage), same as the dashboard's.

function setFilesLayoutVisibility(mode) {
  el('fileListTable').classList.toggle('hidden', mode !== 'list');
  el('fileThumbnailView').classList.toggle('hidden', mode !== 'thumbnail');
  el('fileTreeView').classList.toggle('hidden', mode !== 'tree');
  el('breadcrumbs').classList.toggle('hidden', mode === 'tree');
}

async function renderFiles() {
  setFilesLayoutVisibility(state.filesViewMode);
  const disabled = !state.config.sharedFolder.enabled;
  el('filesDisabledState').classList.toggle('hidden', !disabled);
  el('filesEmptyState').classList.add('hidden');
  if (disabled) {
    el('fileTableBody').innerHTML = '';
    el('fileThumbnailView').innerHTML = '';
    el('fileTreeView').innerHTML = '';
    return;
  }

  if (state.filesViewMode === 'tree') {
    renderBreadcrumbs();
    await renderFileTreeRoot();
    return;
  }

  renderBreadcrumbs();
  try {
    const { items } = await api.listFiles(state.filesPath);
    el('filesEmptyState').classList.toggle('hidden', items.length > 0);
    if (state.filesViewMode === 'thumbnail') renderFilesThumbnailView(items);
    else renderFilesListView(items);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderFilesListView(items) {
  const body = el('fileTableBody');
  body.innerHTML = '';
  for (const item of items) {
    const rowPath = state.filesPath ? `${state.filesPath}/${item.name}` : item.name;
    const tr = document.createElement('tr');
    if (item.type === 'dir') tr.className = 'dir-row';
    tr.innerHTML = `
      <td>${item.type === 'dir' ? '📁' : '📄'}</td>
      <td class="file-name">${escapeHtml(item.name)}</td>
      <td>${item.type === 'dir' ? '—' : formatSize(item.size)}</td>
      <td>${item.modified ? new Date(item.modified).toLocaleString() : '—'}</td>
      <td class="file-row-actions"></td>
    `;
    const actions = tr.querySelector('.file-row-actions');
    if (item.type === 'file') {
      const dl = document.createElement('a');
      dl.href = api.downloadUrl(rowPath);
      dl.textContent = '⬇';
      dl.title = 'Download';
      actions.appendChild(dl);
    }
    if (state.config.sharedFolder.allowDelete) {
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete ${item.name}?`)) return;
        try {
          await api.deleteFile(rowPath);
          renderFiles();
        } catch (err) {
          toast(err.message, true);
        }
      };
      actions.appendChild(del);
    }
    if (item.type === 'dir') {
      tr.addEventListener('click', () => { state.filesPath = rowPath; renderFiles(); });
    }
    body.appendChild(tr);
  }
}

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

function renderFilesThumbnailView(items) {
  const wrap = el('fileThumbnailView');
  wrap.innerHTML = '';
  for (const item of items) {
    const rowPath = state.filesPath ? `${state.filesPath}/${item.name}` : item.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-thumb';

    const iconInner = item.type === 'dir'
      ? '📁'
      : IMAGE_FILE_RE.test(item.name)
        ? `<img src="${escapeAttr(api.downloadUrl(rowPath))}" alt="" loading="lazy" />`
        : '📄';

    btn.innerHTML = `
      <div class="file-thumb-icon">${iconInner}</div>
      <div class="file-thumb-name">${escapeHtml(item.name)}</div>
    `;

    if (item.type === 'dir') {
      btn.addEventListener('click', () => { state.filesPath = rowPath; renderFiles(); });
    } else {
      btn.addEventListener('click', () => window.open(api.downloadUrl(rowPath), '_blank', 'noopener'));
    }
    wrap.appendChild(btn);
  }
}

// Lazily fetches each folder's children only when it's actually expanded,
// reusing the same single-directory endpoint List/Thumbnail already use —
// no new backend route, and no risk of trying to walk a huge shared folder
// in one request. treeExpanded persists across re-renders (e.g. after an
// upload) so expanding a folder doesn't collapse everything else.
const treeExpanded = new Set(['']);

async function renderFileTreeRoot() {
  const wrap = el('fileTreeView');
  wrap.innerHTML = '';
  try {
    wrap.appendChild(await buildTreeNode('', 'shared', true));
  } catch (err) {
    toast(err.message, true);
  }
}

async function buildTreeNode(path, label, isDir) {
  const row = document.createElement('div');
  row.className = 'tree-row' + (isDir && state.filesPath === path ? ' active' : '');
  row.innerHTML = `
    <span class="tree-toggle">${isDir ? (treeExpanded.has(path) ? '▼' : '▶') : ''}</span>
    <span>${isDir ? '📁' : '📄'}</span>
    <span class="tree-name">${escapeHtml(label)}</span>
  `;

  const container = document.createElement('div');
  container.appendChild(row);

  if (!isDir) {
    row.addEventListener('click', () => window.open(api.downloadUrl(path), '_blank', 'noopener'));
    return container;
  }

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'tree-children';
  childrenWrap.classList.toggle('hidden', !treeExpanded.has(path));
  container.appendChild(childrenWrap);

  row.addEventListener('click', async () => {
    state.filesPath = path;
    el('fileTreeView').querySelectorAll('.tree-row.active').forEach((r) => r.classList.remove('active'));
    row.classList.add('active');

    if (treeExpanded.has(path)) {
      treeExpanded.delete(path);
      childrenWrap.classList.add('hidden');
    } else {
      treeExpanded.add(path);
      childrenWrap.classList.remove('hidden');
      if (!childrenWrap.dataset.loaded) {
        await populateTreeChildren(path, childrenWrap);
        childrenWrap.dataset.loaded = 'true';
      }
    }
    row.querySelector('.tree-toggle').textContent = treeExpanded.has(path) ? '▼' : '▶';
  });

  if (treeExpanded.has(path)) {
    await populateTreeChildren(path, childrenWrap);
    childrenWrap.dataset.loaded = 'true';
  }

  return container;
}

async function populateTreeChildren(path, wrapEl) {
  wrapEl.innerHTML = '';
  try {
    const { items } = await api.listFiles(path);
    for (const item of items) {
      const childPath = path ? `${path}/${item.name}` : item.name;
      wrapEl.appendChild(await buildTreeNode(childPath, item.name, item.type === 'dir'));
    }
  } catch (err) {
    toast(err.message, true);
  }
}

el('filesLayoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  state.filesViewMode = btn.dataset.layout;
  localStorage.setItem('mc:filesView', state.filesViewMode);
  el('filesLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  renderFiles();
});

el('mkdirBtn').addEventListener('click', async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    const target = state.filesPath ? `${state.filesPath}/${name}` : name;
    await api.mkdir(target);
    renderFiles();
  } catch (err) {
    toast(err.message, true);
  }
});

el('uploadBtn').addEventListener('click', () => el('uploadInput').click());
el('uploadInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await api.uploadFile(state.filesPath, file);
    renderFiles();
    toast(`Uploaded ${file.name}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = '';
  }
});

const fileDrop = el('fileDrop');
['dragenter', 'dragover'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => { e.preventDefault(); fileDrop.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => { e.preventDefault(); fileDrop.classList.remove('drag-over'); })
);
fileDrop.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  for (const file of files) {
    try {
      await api.uploadFile(state.filesPath, file);
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (files.length) { renderFiles(); toast(`Uploaded ${files.length} file(s)`); }
});

// ---------- Chat ----------
// Multiple channels, each broadcasting its history live to every connected
// device. Text/links plus an optional image or file attachment per
// message — deliberately not a replacement for the shared folder above,
// which still owns moving files that aren't part of a conversation.

const URL_ONLY_RE = /^https?:\/\/\S+$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function timeAgo(isoString) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(isoString).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

// Every device picks its own display name, stored locally — there's no
// account system here, same trust-based model as the rest of the app.
function ensureDeviceName() {
  let name = localStorage.getItem('mc:deviceName');
  if (!name) {
    name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('mc:deviceName', name);
  }
  return name;
}

function renderDeviceNameLabel() {
  el('deviceNameLabel').textContent = state.deviceName;
}

el('deviceNameBtn').addEventListener('click', () => {
  const next = prompt('Your display name in chat:', state.deviceName);
  if (!next) return;
  const trimmed = next.trim().slice(0, 40);
  if (!trimmed) return;
  state.deviceName = trimmed;
  localStorage.setItem('mc:deviceName', trimmed);
  renderDeviceNameLabel();
});

function renderChatBadge() {
  const badge = el('chatBadge');
  badge.textContent = String(state.chatUnseen);
  badge.classList.toggle('hidden', state.chatUnseen === 0);
}

function applyLocalChannelReorder(ids) {
  const byId = new Map((state.config.chatChannels || []).map((c) => [c.id, c]));
  const idSet = new Set(ids);
  let cursor = 0;
  state.config.chatChannels = (state.config.chatChannels || []).map((c) => (idSet.has(c.id) ? byId.get(ids[cursor++]) : c));
}

function renderChatChannels() {
  const wrap = el('chatChannelTabs');
  const channels = state.config.chatChannels || [];
  const canDelete = channels.length > 1;

  wrap.innerHTML = channels.map((c) => `
    <div class="chat-channel-tab ${c.id === state.activeChannelId ? 'active' : ''}" data-id="${c.id}" draggable="true">
      <span class="channel-select">${escapeHtml(c.name)}</span>
      ${canDelete ? `<button class="delete-channel-btn" title="Delete channel">✕</button>` : ''}
    </div>
  `).join('') + `<button type="button" class="chat-channel-tab add-channel" id="addChannelBtn" title="New channel">＋</button>`;

  wrap.querySelectorAll('.chat-channel-tab[data-id]').forEach((tab) => {
    const id = tab.dataset.id;
    tab.querySelector('.channel-select').addEventListener('click', () => switchChannel(id));
    tab.querySelector('.delete-channel-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const channel = channels.find((c) => c.id === id);
      if (!confirm(`Delete #${channel.name}? Its message history goes with it.`)) return;
      try {
        await api.deleteChatChannel(id);
      } catch (err) {
        toast(err.message, true);
      }
    });

    tab.addEventListener('dragstart', (e) => {
      dragOriginContainer = wrap;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id); // required by Firefox to start a drag
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      dragOriginContainer = null;
    });
  });

  el('addChannelBtn').addEventListener('click', showAddChannelInput);
}

// A small inline input in place of the ＋ button rather than a browser
// prompt() — keeps channel creation looking like the rest of the app
// instead of a native OS dialog.
function showAddChannelInput() {
  const addBtn = el('addChannelBtn');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'add-channel-input';
  input.placeholder = 'Channel name…';
  input.maxLength = 40;
  addBtn.replaceWith(input);
  input.focus();

  let settled = false;
  const commit = async () => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (!name) { renderChatChannels(); return; }
    try {
      const channel = await api.createChatChannel(name);
      await switchChannel(channel.id);
    } catch (err) {
      toast(err.message, true);
      renderChatChannels();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { settled = true; renderChatChannels(); }
  });
  input.addEventListener('blur', commit);
}

enableDragReorder(el('chatChannelTabs'), {
  itemSelector: '.chat-channel-tab[data-id]',
  reorder: api.reorderChatChannels,
  onSuccess: applyLocalChannelReorder,
});

// Drives both the outer layout chrome (chat-layout's own mode-* class —
// tabs-above vs. sidebar-beside vs. borderless) and the message bubble
// style, which piggybacks on Tabs vs. everything-else: Sidebar and
// Floating both read as "AI chat interface", so both use the bubble
// treatment; only Tabs keeps the original flat author/time layout.
function applyChatLayoutMode(mode) {
  state.chatViewMode = mode;
  localStorage.setItem('mc:chatView', mode);
  el('chatLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
  el('chatLayout').className = `chat-layout mode-${mode}`;
  renderChatMessages();
}

el('chatLayoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  applyChatLayoutMode(btn.dataset.layout);
});

async function switchChannel(channelId) {
  state.activeChannelId = channelId;
  const channel = (state.config.chatChannels || []).find((c) => c.id === channelId);
  el('chatChannelTitle').textContent = channel ? channel.name : '';
  renderChatChannels();

  if (!state.chatMessages.has(channelId)) {
    try {
      const { messages } = await api.getChatMessages(channelId);
      state.chatMessages.set(channelId, messages);
    } catch (err) {
      toast(err.message, true);
      return;
    }
  }
  renderChatMessages();
}

function attachmentMarkup(attachment) {
  if (!attachment) return '';
  const url = api.attachmentUrl(attachment.filename);
  const isImage = attachment.mimeType?.startsWith('image/') || IMAGE_EXT_RE.test(attachment.originalName);
  if (isImage) {
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener"><img class="chat-attachment-image" src="${escapeAttr(url)}" alt="${escapeAttr(attachment.originalName)}" /></a>`;
  }
  return `<a class="chat-attachment-file" href="${escapeAttr(url)}" target="_blank" rel="noopener">📄 ${escapeHtml(attachment.originalName)} <span>(${formatBytes(attachment.size)})</span></a>`;
}

function renderChatMessages() {
  const list = el('chatMessages');
  const messageStyle = state.chatViewMode === 'tabs' ? 'default' : 'bubbles';
  list.className = `chat-messages mode-${messageStyle}`;
  const messages = state.chatMessages.get(state.activeChannelId) || [];
  el('chatEmptyState').classList.toggle('hidden', messages.length > 0);
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  list.innerHTML = messages.map((m) => {
    const trimmed = m.text.trim();
    const linkified = URL_ONLY_RE.test(trimmed)
      ? `<a href="${escapeAttr(trimmed)}" target="_blank" rel="noopener">${escapeHtml(trimmed)}</a>`
      : escapeHtml(m.text);
    const mine = m.author === state.deviceName;

    return `
      <div class="chat-message ${mine ? 'own' : 'other'}" data-id="${m.id}">
        <div class="chat-message-meta">
          <span class="chat-message-author">${escapeHtml(m.author)}</span>
          <span class="chat-message-time">${timeAgo(m.createdAt)}</span>
          <button class="chat-message-delete" title="Delete">✕</button>
        </div>
        ${trimmed ? `<div class="chat-message-text">${linkified}</div>` : ''}
        ${attachmentMarkup(m.attachment)}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.chat-message').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.chat-message-delete').addEventListener('click', async () => {
      try {
        await api.deleteChatMessage(state.activeChannelId, id);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

let pendingAttachment = null;

function updateAttachmentPreview() {
  const preview = el('chatAttachmentPreview');
  if (pendingAttachment) {
    el('chatAttachmentName').textContent = `📎 ${pendingAttachment.name}`;
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
  }
}

el('chatAttachBtn').addEventListener('click', () => el('chatFileInput').click());
el('chatFileInput').addEventListener('change', (e) => {
  pendingAttachment = e.target.files[0] || null;
  updateAttachmentPreview();
});
el('chatAttachmentRemove').addEventListener('click', () => {
  pendingAttachment = null;
  el('chatFileInput').value = '';
  updateAttachmentPreview();
});

el('chatTextInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el('chatForm').requestSubmit();
  }
});

el('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const textEl = el('chatTextInput');
  const text = textEl.value.trim();
  if (!text && !pendingAttachment) return;
  try {
    await api.sendChatMessage(state.activeChannelId, { author: state.deviceName, text, file: pendingAttachment });
    textEl.value = '';
    pendingAttachment = null;
    el('chatFileInput').value = '';
    updateAttachmentPreview();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Omnibox quick launcher ----------

const omniboxModal = el('omniboxModal');
const omniboxInput = el('omniboxInput');
const omniboxResultsEl = el('omniboxResults');
let omniboxResults = [];
let omniboxSelectedIndex = 0;

function openOmnibox() {
  omniboxInput.value = '';
  renderOmniboxResults('');
  omniboxModal.classList.remove('hidden');
  omniboxInput.focus();
}

function closeOmnibox() {
  omniboxModal.classList.add('hidden');
}

function renderOmniboxResults(query) {
  const q = query.trim().toLowerCase();
  omniboxResults = state.config.services
    .filter((s) => !q || `${s.name} ${(s.tags || []).join(' ')} ${s.url}`.toLowerCase().includes(q))
    .slice(0, 8);
  omniboxSelectedIndex = 0;

  if (omniboxResults.length === 0) {
    omniboxResultsEl.innerHTML = '<div class="omnibox-empty">No matches</div>';
    return;
  }

  omniboxResultsEl.innerHTML = omniboxResults.map((s, i) => {
    const group = groupById(s.group);
    return `
      <div class="omnibox-result ${i === 0 ? 'active' : ''}" data-index="${i}">
        <span class="omnibox-icon">${s.icon || '🔗'}</span>
        <span class="omnibox-name">${escapeHtml(s.name)}</span>
        <span class="omnibox-url">${escapeHtml(s.url)}</span>
        ${group ? `<span class="card-group-badge" style="background:${group.color}22;color:${group.color}">${escapeHtml(group.name)}</span>` : ''}
      </div>
    `;
  }).join('');

  omniboxResultsEl.querySelectorAll('.omnibox-result').forEach((row) => {
    row.addEventListener('click', () => openOmniboxSelection(Number(row.dataset.index)));
  });
}

function updateOmniboxSelection() {
  const rows = omniboxResultsEl.querySelectorAll('.omnibox-result');
  rows.forEach((row, i) => row.classList.toggle('active', i === omniboxSelectedIndex));
  rows[omniboxSelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function openOmniboxSelection(index) {
  const service = omniboxResults[index];
  if (!service) return;
  window.open(service.url, '_blank', 'noopener');
  closeOmnibox();
}

omniboxInput.addEventListener('input', (e) => renderOmniboxResults(e.target.value));

omniboxInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    omniboxSelectedIndex = Math.min(omniboxSelectedIndex + 1, omniboxResults.length - 1);
    updateOmniboxSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    omniboxSelectedIndex = Math.max(omniboxSelectedIndex - 1, 0);
    updateOmniboxSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openOmniboxSelection(omniboxSelectedIndex);
  } else if (e.key === 'Escape') {
    closeOmnibox();
  }
});

omniboxModal.addEventListener('click', (e) => {
  if (e.target === omniboxModal) closeOmnibox();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  e.preventDefault();
  openOmnibox();
});

// ---------- Render + boot ----------

function render() {
  renderGroupFilters();
  renderCards();
  renderOnlineBadge();
}

renderDeviceNameLabel();
el('dashboardLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.dashboardViewMode));
el('filesLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.filesViewMode));
el('chatLayout').className = `chat-layout mode-${state.chatViewMode}`;
el('chatLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.chatViewMode));
loadAll().catch((err) => toast(err.message, true));
setInterval(pollStatus, 5000);
pollHostHealth();
setInterval(pollHostHealth, 10000);
connectWebSocket({
  status: handleWsStatus,
  config: handleWsConfig,
  chatMessage: handleWsChatMessage,
  chatMessageDeleted: handleWsChatMessageDeleted,
});
