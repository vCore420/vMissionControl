import { api } from './api.js';
import { drawConnectionLines, buildAdjacency, highlightNeighbors, clearHighlight } from './connections.js';
import {
  state, el, toast, escapeHtml, escapeAttr, copyToClipboard, groupById, loadAll,
  dragState, enableDragReorder,
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

function controlButtonsMarkup(service, btnClass) {
  if (!serviceControlAvailable(service)) return '';
  const c = service.controller;
  // Docker actions are standardized by the Engine API itself — there's no
  // per-action command to check for, unlike script controllers where each
  // button only appears if that specific command was actually filled in.
  if (c.type === 'docker') {
    return `
      <button type="button" class="${btnClass} control-btn" data-action="start" title="Start">▶</button>
      <button type="button" class="${btnClass} control-btn" data-action="stop" title="Stop">⏹</button>
      <button type="button" class="${btnClass} control-btn" data-action="restart" title="Restart">⟲</button>
      <button type="button" class="${btnClass} logs-btn" title="View logs">📜</button>
    `;
  }
  return `
    ${c.startCmd ? `<button type="button" class="${btnClass} control-btn" data-action="start" title="Start">▶</button>` : ''}
    ${c.stopCmd ? `<button type="button" class="${btnClass} control-btn" data-action="stop" title="Stop">⏹</button>` : ''}
    ${c.restartCmd ? `<button type="button" class="${btnClass} control-btn" data-action="restart" title="Restart">⟲</button>` : ''}
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
  if (mode !== 'card') el('pinnedSection').classList.add('hidden');
  svgOverlay.classList.toggle('visible', mode === 'card' && state.connectionsVisible);
}

export function renderCards() {
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

export function renderCardStatuses() {
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
  } else {
    el('serviceModalTitle').textContent = 'Add Service';
    serviceForm.elements.healthCheckPath.value = '/';
    updateControllerFieldVisibility('');
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

const logsModal = el('logsModal');
let logsPollTimer = null;
let logsServiceId = null;

async function fetchAndRenderLogs() {
  if (!logsServiceId) return;
  const output = el('logsOutput');
  try {
    const { logs } = await api.getServiceLogs(logsServiceId);
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
  logsServiceId = service.id;
  el('logsModalTitle').textContent = `${service.name} — logs`;
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
  logsServiceId = null;
}

el('refreshLogsBtn').addEventListener('click', fetchAndRenderLogs);
el('closeLogsBtn').addEventListener('click', closeLogsModal);
logsModal.addEventListener('click', (e) => { if (e.target === logsModal) closeLogsModal(); });
