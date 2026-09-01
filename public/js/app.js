import { connectWebSocket } from './ws.js';
import {
  state, el, toast, callbacks, loadAll, loadProfiles, pollStatus,
  handleWsStatus, handleWsConfig, handleWsChatMessage, handleWsChatMessageUpdated,
  handleWsChatMessageDeleted, handleWsTimesheet, handleWsProfile,
  handleWsCodeSessions, handleWsCodeMessage, handleWsCodeMessageUpdated, handleWsCodeTurn, handleWsCodeBackground,
  handleWsArtWallpapers, handleWsArtProgress, handleWsActivity,
} from './core.js';
import { renderGroupFilters, renderCards, renderOnlineBadge, renderCardStatuses } from './dashboard.js';
import { renderFiles } from './files.js';
import {
  renderChatBadge, renderChatChannels, renderChatMessages, switchChannel, renderDeviceNameLabel,
  renderChatAiToggle, applyChatLayoutClasses,
} from './chat.js';
import {
  renderCodeSessions, renderCodeMessages, renderCodeTasks, renderCodeBackground, enterCodeView, applyCodeGate,
} from './code.js';
import { pollHostHealth, renderProfileSection, renderWallpaperSection } from './settings.js';
import { renderTimesheet } from './timesheet.js';
import { renderActivity } from './activity.js';
import { initKiosk } from './kiosk.js';
import './omnibox.js';

// Entry point: registers the service worker, wires core.js's sync-engine
// callbacks to the real per-view render functions (see core.js's own
// comment for why — this is what keeps the module graph from needing any
// circular imports), owns the top nav view switcher, and starts the
// initial load + poll/WebSocket loops. Everything else lives in its own
// view module (core.js, dashboard.js, files.js, chat.js, settings.js,
// omnibox.js) and is reached only through this file's imports or through
// that module's own DOM event listeners.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

function render() {
  renderGroupFilters();
  renderCards();
  renderOnlineBadge();
  renderChatAiToggle();
}

callbacks.render = render;
callbacks.renderStatuses = renderCardStatuses;
callbacks.renderChatBadge = renderChatBadge;
callbacks.renderChatChannels = renderChatChannels;
callbacks.renderChatMessages = renderChatMessages;
callbacks.switchChannel = switchChannel;
callbacks.renderTimesheet = renderTimesheet;
callbacks.renderCodeSessions = renderCodeSessions;
callbacks.renderCodeMessages = renderCodeMessages;
callbacks.renderCodeTasks = renderCodeTasks;
callbacks.renderCodeBackground = renderCodeBackground;
callbacks.applyCodeGate = applyCodeGate;
callbacks.renderDeviceNameLabel = renderDeviceNameLabel;
callbacks.renderProfileSection = renderProfileSection;
callbacks.renderWallpaperSection = renderWallpaperSection;

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
  if (view === 'code') enterCodeView();
  if (view === 'timesheet') renderTimesheet({ forceFetch: true });
  if (view === 'activity') renderActivity();
});

// ---------- Render + boot ----------

renderDeviceNameLabel();
el('dashboardLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.dashboardViewMode));
el('filesLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.filesViewMode));
applyChatLayoutClasses();
el('chatLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.chatViewMode));
loadAll().catch((err) => toast(err.message, true));
loadProfiles();
// After the layout switch is wired but before the poll loops — kiosk mode
// forces the Board view and re-renders once config arrives from loadAll().
// Guarded so a kiosk bug can never take the rest of the app's boot with it.
try { initKiosk(); } catch (err) { console.error('[kiosk] init failed', err); }
setInterval(pollStatus, 5000);
pollHostHealth();
setInterval(pollHostHealth, 10000);
connectWebSocket({
  status: handleWsStatus,
  config: handleWsConfig,
  chatMessage: handleWsChatMessage,
  chatMessageUpdated: handleWsChatMessageUpdated,
  chatMessageDeleted: handleWsChatMessageDeleted,
  timesheet: handleWsTimesheet,
  codeSessions: handleWsCodeSessions,
  codeMessage: handleWsCodeMessage,
  codeMessageUpdated: handleWsCodeMessageUpdated,
  codeTurn: handleWsCodeTurn,
  codeBackground: handleWsCodeBackground,
  profile: handleWsProfile,
  artWallpapers: handleWsArtWallpapers,
  artProgress: handleWsArtProgress,
  activity: handleWsActivity,
});
