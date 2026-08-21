import { api } from './api.js';

// Shared application state, DOM/formatting helpers, the WebSocket/poll data
// sync engine, and generic cross-view utilities (drag-reorder, info tips).
// Every other frontend module imports from here; this module never imports
// from a view module (dashboard.js/files.js/chat.js/settings.js/
// omnibox.js) — that one-directional dependency graph is what keeps the
// split from turning into a tangle of circular imports. Where the sync
// engine below needs to trigger a view-specific render (a new WS message,
// a poll tick), it calls through `callbacks`, which app.js populates once
// at boot with the real render functions from each view module.

export const state = {
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
  // Populated on first visit to the Timesheets tab and kept current by the
  // 'timesheet' WS broadcast — the server is the one source of truth for
  // both, so there's no separate per-device copy the way chat messages
  // briefly are before the network round-trip.
  timesheetProfile: null,
  timesheetPeriod: null,
};

export const el = (id) => document.getElementById(id);

export function toast(message, isError = false) {
  const t = el('toast');
  t.textContent = message;
  t.classList.remove('hidden');
  t.style.borderColor = isError ? 'var(--offline)' : 'var(--border)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- Info tips ----------
// The small "ⓘ" buttons that replaced always-visible hint paragraphs in
// the Add/Edit Service and Settings modals. CSS alone handles hover/focus
// reveal; this only adds tap-to-toggle for touch devices (where :hover
// never fires) plus outside-click/Escape to close one left open. Delegated
// on document since these buttons live inside modals that get shown/hidden
// rather than re-created, so binding once at load is enough.
//
// The bubble's default position (CSS: centered under its button) works
// for any button that sits away from the modal's edges — true of every
// Settings info-tip, measured directly. The Add/Edit Service modal has a
// couple that sit close to the right edge instead, where a centered
// bubble still runs past it. Rather than hand-tune per-modal CSS again,
// this measures the bubble against its modal's actual bounds each time it
// opens and nudges it back in if it would overflow, so any button
// position in any modal stays correct without needing to know in advance
// where that button happens to be.
function positionInfoTipBubble(tip) {
  const bubble = tip.querySelector('.info-tip-bubble');
  if (!bubble) return;
  // The stylesheet transitions both opacity and transform on open (a
  // small slide-down reveal). Measuring position synchronously while that
  // transition is live reads a mid-animation value, not the settled one —
  // this showed up as the correction being computed against the wrong
  // rect and then itself getting animated from a stale starting point.
  // Scoping transitionProperty to just opacity for the correction (then
  // restoring it after a forced reflow) keeps the reveal fade but makes
  // the position land instantly and correctly.
  bubble.style.transitionProperty = 'opacity';
  bubble.style.transform = 'translateX(-50%)';
  const bounds = (tip.closest('.modal-card') || document.body).getBoundingClientRect();
  const rect = bubble.getBoundingClientRect();
  const margin = 8;
  let shift = 0;
  if (rect.left < bounds.left + margin) shift = bounds.left + margin - rect.left;
  else if (rect.right > bounds.right - margin) shift = bounds.right - margin - rect.right;
  if (shift) bubble.style.transform = `translateX(calc(-50% + ${shift}px))`;
  void bubble.offsetHeight;
  bubble.style.transitionProperty = '';
}

document.addEventListener('click', (e) => {
  const tip = e.target.closest('.info-tip');
  if (tip) {
    const wasOpen = tip.classList.contains('tip-open');
    document.querySelectorAll('.info-tip.tip-open').forEach((b) => b.classList.remove('tip-open'));
    if (!wasOpen) {
      tip.classList.add('tip-open');
      positionInfoTipBubble(tip);
    }
    return;
  }
  document.querySelectorAll('.info-tip.tip-open').forEach((b) => b.classList.remove('tip-open'));
});

// mouseenter doesn't bubble, so delegating it needs the capture phase —
// this is what actually covers desktop mouse users, who trigger the
// bubble via :hover in CSS and never touch the click handler above at all.
document.addEventListener('mouseenter', (e) => {
  const tip = e.target.closest?.('.info-tip');
  if (tip) positionInfoTipBubble(tip);
}, true);

document.addEventListener('focusin', (e) => {
  const tip = e.target.closest('.info-tip');
  if (tip) positionInfoTipBubble(tip);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.info-tip.tip-open').forEach((b) => b.classList.remove('tip-open'));
});

// navigator.clipboard only exists in a secure context (https:// or
// localhost) — a device opening this over a plain-HTTP LAN address (the
// normal way to reach this app from a phone) doesn't have it at all, so
// the modern API silently fails there. This falls back to the old
// execCommand trick, which has no such restriction.
export async function copyToClipboard(text) {
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

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function escapeAttr(str) { return escapeHtml(str); }

export function groupById(id) {
  return state.config.groups.find((g) => g.id === id) || null;
}

// ---------- Formatters ----------

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

export function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

export function formatGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

export function timeAgo(isoString) {
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

export function healthBarClass(percent) {
  if (percent >= 85) return 'offline';
  if (percent >= 60) return 'checking';
  return 'online';
}

// Local/private addresses are worth polling for uptime; a public website
// bookmark usually isn't — this just sets a sensible starting point for the
// checkbox when adding a new entry, the user can always override it.
export function isLocalUrl(url) {
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

// Every device picks its own display name, stored locally — there's no
// account system here, same trust-based model as the rest of the app.
// Defined here (not chat.js) because `state` above needs it synchronously
// at module-evaluation time, before any view module has run.
export function ensureDeviceName() {
  let name = localStorage.getItem('mc:deviceName');
  if (!name) {
    name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('mc:deviceName', name);
  }
  return name;
}

// ---------- Drag-to-reorder ----------
// Generic drag-to-reorder for any flat list of elements with a data-id —
// used for both the service card grids (dashboard.js) and the chat channel
// tabs (chat.js). dragState.originContainer scopes each drag to the grid/
// list it started in; it's a plain mutable object (not a bare exported
// `let`) because ES module import bindings are read-only, and both
// dashboard.js and chat.js need to write to it, not just read it.

export const dragState = { originContainer: null };

export function getDragTarget(container, x, y, selector) {
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

// reorder(ids) persists the new order server-side; onSuccess/onError update
// local state to match (or resync from the server if the request failed).
export function enableDragReorder(container, { itemSelector = '.service-card', reorder, onSuccess, onError } = {}) {
  container.addEventListener('dragover', (e) => {
    if (dragState.originContainer !== container) return;
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
    if (dragState.originContainer !== container) return;
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

// ---------- Data loading + real-time sync ----------
// Every connected device pushes and receives the same config/status/chat
// changes over one shared WebSocket connection (see ws.js + app.js's boot
// sequence for where this actually gets wired up and started). The 5s REST
// poll stays in place as a fallback in case a socket never connects or is
// mid-reconnect.
//
// `callbacks` is how this reaches into view-specific rendering without
// core.js importing any view module — app.js fills these in once, right
// after importing the real render functions from dashboard.js/chat.js.
export const callbacks = {
  render: () => {},
  renderStatuses: () => {},
  renderChatBadge: () => {},
  renderChatChannels: () => {},
  renderChatMessages: () => {},
  switchChannel: () => {},
  renderTimesheet: () => {},
};

export function applyStatus(list) {
  for (const s of list) state.status.set(s.id, s);
}

// Shared by both the REST poll and the WebSocket push so a status change
// only ever gets diffed/notified/rendered once, regardless of which
// transport delivered it first.
export function applyIncomingStatus(list) {
  const prev = new Map(Array.from(state.status.entries()).map(([id, s]) => [id, s.status]));
  applyStatus(list);
  handleStatusTransitions(prev);
  callbacks.renderStatuses();
}

export async function loadAll() {
  const [config, status] = await Promise.all([api.getConfig(), api.getStatus()]);
  state.config = config;
  applyStatus(status.services);
  callbacks.render();
}

export async function pollStatus() {
  try {
    const status = await api.getStatus();
    applyIncomingStatus(status.services);
  } catch {
    // transient network hiccup — next poll will retry
  }
}

export function handleWsStatus(msg) {
  applyIncomingStatus(msg.services);
}

export function handleWsConfig(msg) {
  if (dragState.originContainer) return; // don't yank a card out from under an active drag; the next update will reconcile
  state.config = msg.config;
  callbacks.render();

  if (el('chatView').classList.contains('active')) {
    const stillExists = (state.config.chatChannels || []).some((c) => c.id === state.activeChannelId);
    if (!stillExists) {
      const first = (state.config.chatChannels || [])[0];
      if (first) callbacks.switchChannel(first.id);
    } else {
      callbacks.renderChatChannels();
    }
  }
}

export function handleWsChatMessage(msg) {
  const list = state.chatMessages.get(msg.channelId) || [];
  list.push(msg.message);
  state.chatMessages.set(msg.channelId, list);
  if (el('chatView').classList.contains('active') && state.activeChannelId === msg.channelId) {
    callbacks.renderChatMessages();
  } else {
    state.chatUnseen += 1;
    callbacks.renderChatBadge();
  }
}

export function handleWsChatMessageDeleted(msg) {
  const list = state.chatMessages.get(msg.channelId) || [];
  state.chatMessages.set(msg.channelId, list.filter((m) => m.id !== msg.messageId));
  if (el('chatView').classList.contains('active') && state.activeChannelId === msg.channelId) {
    callbacks.renderChatMessages();
  }
}

// A second open device's edit (or a server-side fortnight rollover)
// arriving live. Always updates state — a background tab still needs
// current data waiting for it when switched to — but only re-renders the
// DOM if Timesheets is the visible view, same guard chat messages use.
export function handleWsTimesheet(msg) {
  state.timesheetProfile = msg.profile;
  state.timesheetPeriod = msg.period;
  if (el('timesheetView').classList.contains('active')) {
    callbacks.renderTimesheet();
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
