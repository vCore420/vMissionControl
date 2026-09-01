import { api } from './api.js';
import {
  state, el, toast, escapeHtml, escapeAttr, loadAll, timeAgo, setLocal,
  healthBarClass, formatGB, formatSize, formatUptime, applyWallpaper, artProgressListeners,
} from './core.js';
import { renderConnectionOverlay } from './dashboard.js';
import { avatarMarkup } from './avatar.js';

// The Settings modal — one section per tab: Profile, Appearance (theme),
// Services (groups + health-check interval), Notifications, Ollama, ComfyUI,
// Jellyfin, Code, Snippets, Scheduled, Sharing, Security (password / IP
// allowlist / service control), Devices, Backup. Plus the standalone Host
// Health modal, which lives here since it's reached from the same hero pill
// Settings itself sits next to. `pollHostHealth` is exported so app.js's
// boot sequence can start the poll loop; everything else is self-contained,
// reached only through this module's own event listeners.

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
  { id: 'dracula', name: 'Dracula', bg: '#282a36', accent: '#bd93f9' },
  { id: 'solarized', name: 'Solarized', bg: '#002b36', accent: '#268bd2' },
  { id: 'highcontrast', name: 'High Contrast', bg: '#000000', accent: '#00d9ff' },
];

// ---------- Custom theme ----------
// Every preset theme above is really just a hand-tuned set of the same 16
// tokens (see style.css's [data-theme] blocks) — backgrounds/cards/hover
// states, three text levels, accent + its dim shade, and four status
// colors. Exposing all 16 as raw pickers would work but isn't the "small
// menu" this was asked for; exposing the 8 that actually carry distinct
// meaning and deriving the rest (lighten/darken relationships mirrored
// from how the presets already relate to each other) gets a full-coverage
// custom theme out of a compact form.
const CUSTOM_THEME_FIELDS = [
  { key: 'bg', label: 'Background' },
  { key: 'text', label: 'Text' },
  { key: 'accent', label: 'Accent' },
  { key: 'border', label: 'Border' },
  { key: 'online', label: 'Online' },
  { key: 'offline', label: 'Offline' },
  { key: 'unmonitored', label: 'Unmonitored' },
  { key: 'checking', label: 'Checking' },
];

const DEFAULT_CUSTOM_COLORS = {
  bg: '#0d0f14', text: '#e8eaf0', accent: '#7c5cff', border: '#262b3a',
  online: '#4ade80', offline: '#f87171', unmonitored: '#6b7280', checking: '#fbbf24',
};

// The full token set a [data-theme] CSS block declares — used to clear
// any leftover inline overrides when switching away from Custom, since an
// inline style always beats a stylesheet rule regardless of which preset
// is now selected.
const THEME_TOKEN_KEYS = [
  'bg', 'bg-panel', 'bg-elevated', 'bg-card', 'bg-card-hover', 'border',
  'text', 'text-dim', 'text-faint', 'accent', 'accent-dim',
  'online', 'offline', 'unmonitored', 'checking', 'dot',
];

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

// ratio 0 = pure a, 1 = pure b
function mixHex(hexA, hexB, ratio) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * ratio));
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Mirrors how the hand-tuned presets relate their own surfaces to each
// other (checked against Dark's actual values) — panel/elevated/card/hover
// step progressively further from bg *toward text*, which lightens them
// in a dark theme and darkens them in a light one without needing to know
// which case it is. text-dim/faint and accent-dim step the other way,
// fading toward bg. Border and the four status colors are picked directly
// rather than derived — they carry real semantic/legibility weight a
// formula shouldn't be guessing at.
function deriveCustomTokens(c) {
  return {
    bg: c.bg,
    'bg-panel': mixHex(c.bg, c.text, 0.06),
    'bg-elevated': mixHex(c.bg, c.text, 0.10),
    'bg-card': mixHex(c.bg, c.text, 0.13),
    'bg-card-hover': mixHex(c.bg, c.text, 0.18),
    border: c.border,
    text: c.text,
    'text-dim': mixHex(c.text, c.bg, 0.38),
    'text-faint': mixHex(c.text, c.bg, 0.62),
    accent: c.accent,
    'accent-dim': mixHex(c.accent, c.bg, 0.42),
    online: c.online,
    offline: c.offline,
    unmonitored: c.unmonitored,
    checking: c.checking,
    dot: hexToRgba(c.text, 0.09),
  };
}

function applyCustomTokens(tokens) {
  for (const [key, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
}

function loadCustomColors() {
  try {
    return JSON.parse(localStorage.getItem('mc:customColors')) || DEFAULT_CUSTOM_COLORS;
  } catch {
    return DEFAULT_CUSTOM_COLORS;
  }
}

// Saves both the 8 raw picks (so the form can be repopulated next time
// it's opened) and the fully-derived 16-token set (so the pre-paint
// script in index.html/login.html never has to duplicate the color math
// above — it only ever loops over already-computed values).
function saveAndApplyCustomTheme(colors) {
  const tokens = deriveCustomTokens(colors);
  setLocal('mc:customColors', JSON.stringify(colors));
  setLocal('mc:customTokens', JSON.stringify(tokens));
  applyCustomTokens(tokens);
}

function renderCustomThemePanel() {
  const panel = el('customThemePanel');
  const isCustom = state.theme === 'custom';
  panel.classList.toggle('hidden', !isCustom);
  if (!isCustom) return;

  const colors = loadCustomColors();
  el('customThemeFields').innerHTML = CUSTOM_THEME_FIELDS.map((f) => `
    <label class="custom-theme-field">
      <input type="color" data-color-key="${f.key}" value="${colors[f.key]}" />
      ${f.label}
    </label>
  `).join('');
  el('customThemeFields').querySelectorAll('input[type="color"]').forEach((input) => {
    input.addEventListener('input', () => {
      const next = { ...loadCustomColors(), [input.dataset.colorKey]: input.value };
      saveAndApplyCustomTheme(next);
      renderThemeGrid(); // keeps the Custom swatch's own preview live
    });
  });
}

function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  setLocal('mc:theme', themeId);
  state.theme = themeId;
  if (themeId === 'custom') {
    saveAndApplyCustomTheme(loadCustomColors());
  } else {
    for (const key of THEME_TOKEN_KEYS) document.documentElement.style.removeProperty(`--${key}`);
  }
  renderThemeGrid();
  renderCustomThemePanel();
  if (state.connectionsVisible) requestAnimationFrame(renderConnectionOverlay);
}

function renderThemeGrid() {
  const wrap = el('themeGrid');
  const customColors = loadCustomColors();
  const swatches = [...THEMES, { id: 'custom', name: 'Custom', bg: customColors.bg, accent: customColors.accent }];
  wrap.innerHTML = swatches.map((t) => `
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
renderCustomThemePanel();

// ---------- Wallpaper (creative roadmap Phase 1) ----------
// The pool of generated wallpapers is shared (state.wallpapers, kept current
// by the 'artWallpapers' broadcast); the pick is per-device (state.wallpaper,
// applied via core.js#applyWallpaper). Generation is a long synchronous POST
// with sampler progress streamed over the socket.

let wallpaperBusy = false;
let wallpapersLoaded = false;

export function renderWallpaperSection() {
  const grid = el('wallpaperGrid');
  if (!grid) return;
  const comfyOn = !!state.config?.comfy?.enabled;

  el('wallpaperComfyHint').style.display = comfyOn ? 'none' : '';
  el('generateWallpaperBtn').disabled = !comfyOn || wallpaperBusy;
  el('wallpaperPrompt').disabled = !comfyOn || wallpaperBusy;

  const tiles = [
    `<button type="button" class="wallpaper-tile wallpaper-none ${state.wallpaper ? '' : 'active'}" data-wp="">None</button>`,
    ...state.wallpapers.map((w) => `
      <div class="wallpaper-tile ${state.wallpaper === w.id ? 'active' : ''}" data-wp="${escapeAttr(w.id)}"
           title="${escapeAttr(w.themeId ? `generated for the ${w.themeId} theme` : 'generated wallpaper')}">
        <img src="${escapeAttr(api.wallpaperImageUrl(w.id))}" alt="" loading="lazy" />
        <button type="button" class="wallpaper-del" data-del="${escapeAttr(w.id)}" title="Delete this wallpaper">✕</button>
      </div>
    `),
  ];
  grid.innerHTML = tiles.join('');

  grid.querySelectorAll('.wallpaper-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.wallpaper-del')) return;
      applyWallpaper(tile.dataset.wp || null);
      renderWallpaperSection();
    });
  });
  grid.querySelectorAll('.wallpaper-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      if (!confirm('Delete this wallpaper for every device?')) return;
      try {
        await api.deleteWallpaper(id);
        // the 'artWallpapers' broadcast refreshes the grid + clears the pick
        // if it was the active one; nothing else to do here
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

async function loadWallpapers() {
  try {
    const { wallpapers } = await api.listWallpapers();
    state.wallpapers = wallpapers || [];
  } catch {
    state.wallpapers = [];
  }
  renderWallpaperSection();
}

function setWallpaperProgress(text) {
  const box = el('wallpaperProgress');
  if (!box) return;
  box.classList.toggle('hidden', !text);
  box.textContent = text || '';
}

// core.js fans 'artProgress' broadcasts for this device out to every
// listener; this one owns the wallpaper (Appearance) + avatar (Profile)
// progress lines. The service-icon one lives in dashboard.js.
function settingsArtProgress(msg) {
  const label = msg.phase === 'sampling' ? `Generating… step ${msg.value}/${msg.max}`
    : msg.phase === 'done' ? 'Finishing up…'
    : '';
  if (msg.kind === 'wallpaper') setWallpaperProgress(label);
  else if (msg.kind === 'avatar') setAvatarProgress(label);
}
artProgressListeners.add(settingsArtProgress);

el('generateWallpaperBtn').addEventListener('click', async () => {
  if (wallpaperBusy) return;
  wallpaperBusy = true;
  renderWallpaperSection();
  setWallpaperProgress('Starting… (this takes a few minutes on CPU)');
  try {
    const { wallpaper } = await api.generateWallpaper(state.theme, el('wallpaperPrompt').value.trim());
    // the broadcast has already updated state.wallpapers; select the new one
    applyWallpaper(wallpaper.id);
    el('wallpaperPrompt').value = '';
    toast('Wallpaper generated');
  } catch (err) {
    toast(err.message, true);
  } finally {
    wallpaperBusy = false;
    setWallpaperProgress('');
    renderWallpaperSection();
  }
});

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

// Renders the full breakdown into whichever element id is passed in — used
// by the standalone Host Health modal, parametrized in case a second full
// view ever wants it again.
function renderHostHealth(targetId, h) {
  const wrap = el(targetId);
  if (!h) {
    wrap.innerHTML = '<p style="color:var(--text-faint);font-size:0.85rem;margin:0;">Host stats unavailable.</p>';
    return;
  }

  const memPercent = Math.round((h.memory.used / h.memory.total) * 100);
  const diskPercent = h.disk ? Math.round((h.disk.used / h.disk.total) * 100) : null;

  const mc = h.mc || {};
  // Not a status this app actively monitors elsewhere, so it gets its own
  // rough thresholds rather than reusing healthBarClass's — a loop that's
  // 200ms+ behind is worth a second look, a full second behind is worth
  // treating like an active problem.
  const lagClass = mc.eventLoopLagMs >= 1000 ? 'offline' : mc.eventLoopLagMs >= 200 ? 'checking' : 'online';

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
    <div class="host-section-label">Mission Control</div>
    <div class="host-facts">
      <div class="host-fact"><span>Process uptime</span><span>${formatUptime(mc.uptimeSeconds ?? 0)}</span></div>
      <div class="host-fact"><span>Memory footprint</span><span>${formatSize(mc.memoryRss ?? 0)}</span></div>
      <div class="host-fact"><span>Connected devices</span><span>${mc.wsClients ?? '—'}</span></div>
      <div class="host-fact"><span>Active sessions</span><span>${mc.sessions ?? '—'}</span></div>
      <div class="host-fact"><span>Event loop lag</span><span class="host-fact-${lagClass}">${mc.eventLoopLagMs ?? 0}ms</span></div>
      <div class="host-fact"><span>Last health sweep</span><span>${mc.lastHealthSweepAt ? timeAgo(mc.lastHealthSweepAt) : 'not yet run'}</span></div>
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

// One poll loop, always running (started by app.js's boot sequence) — the
// hero pill needs live data on every tab regardless of whether the modal
// is open, and the modal (when it is open) just piggybacks on the same
// tick instead of running a second timer alongside it.
let lastHostHealth = null;

export async function pollHostHealth() {
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

  el('serviceControlEnabled').checked = state.config.security.serviceControl.enabled;
  el('serviceControlEnabled').disabled = !enabled && !state.config.security.serviceControl.enabled;
  el('serviceControlAuthWarning').classList.toggle('hidden', enabled);
  el('serviceControlError').classList.add('hidden');
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

el('saveServiceControlBtn').addEventListener('click', async () => {
  const errorEl = el('serviceControlError');
  errorEl.classList.add('hidden');
  try {
    await api.updateSettings({
      security: { serviceControl: { enabled: el('serviceControlEnabled').checked } },
    });
    await loadAll();
    renderAuthSection();
    toast('Service control setting saved');
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
  const confirmValue = fd.get('confirm');

  if (password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (password !== confirmValue) {
    errorEl.textContent = "Passwords don't match.";
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    await api.setPassword(password);
    await loadAll();
    renderAuthSection();
    renderOllamaSection();
    renderCodeSection();
    renderComfySection();
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
    renderOllamaSection();
    renderCodeSection();
    renderComfySection();
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

// ---------- Ollama Assistant ----------
// Config only, at this milestone — the Chat-view toggle and the actual
// message routing land in later milestones. `ollama` in state.config is
// forwarded straight from config.json (sanitizeConfig only strips auth).

let ollamaModelsLoaded = false;

function renderOllamaSection() {
  const o = state.config.ollama;
  el('ollamaBaseUrl').value = o.baseUrl;
  el('ollamaBotName').value = o.botName;
  el('ollamaBotEmoji').value = o.botEmoji;
  el('ollamaSystemPrompt').value = o.systemPrompt;
  el('ollamaTrigger').value = o.trigger;
  el('ollamaContextMessages').value = o.contextMessages;
  el('ollamaKeepAlive').value = o.keepAlive;
  el('ollamaNumPredict').value = o.numPredict;
  el('ollamaTimeoutSec').value = Math.round(o.requestTimeoutMs / 1000);
  el('ollamaTools').checked = !!o.tools;
  const authOn = !!state.config.auth?.enabled;
  el('ollamaActions').checked = !!o.actions;
  el('ollamaActions').disabled = !authOn && !o.actions;
  el('ollamaActionsWarning').classList.toggle('hidden', authOn);
  el('ollamaSaveError').classList.add('hidden');
  el('ollamaModelsError').classList.add('hidden');
  el('ollamaTestResult').classList.add('hidden');
}

// Hits Ollama (via our proxy) for the installed-model list. Reads the URL
// that's currently *saved*, so the flow is: type URL → Save → ↻. A model
// that's saved but not installed stays selectable so a save can't silently
// drop it.
async function loadOllamaModels() {
  const select = el('ollamaModel');
  const errEl = el('ollamaModelsError');
  const saved = state.config.ollama.model;
  errEl.classList.add('hidden');
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const { models } = await api.getOllamaModels();
    if (!models.length) {
      select.innerHTML = '<option value="">No models installed — run `ollama pull <model>` first</option>';
      return;
    }
    select.innerHTML = models.map((m) => {
      const label = m.parameterSize ? `${m.name} (${m.parameterSize})` : m.name;
      return `<option value="${escapeAttr(m.name)}"${m.name === saved ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    if (saved && !models.some((m) => m.name === saved)) {
      select.insertAdjacentHTML('afterbegin',
        `<option value="${escapeAttr(saved)}" selected>${escapeHtml(saved)} — not installed</option>`);
    }
  } catch (err) {
    select.innerHTML = `<option value="${escapeAttr(saved)}" selected>${escapeHtml(saved || '(none selected)')}</option>`;
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

el('refreshOllamaModelsBtn').addEventListener('click', loadOllamaModels);

el('saveOllamaBtn').addEventListener('click', async () => {
  const errEl = el('ollamaSaveError');
  errEl.classList.add('hidden');
  try {
    await api.updateSettings({
      ollama: {
        baseUrl: el('ollamaBaseUrl').value.trim(),
        model: el('ollamaModel').value,
        botName: el('ollamaBotName').value.trim(),
        botEmoji: el('ollamaBotEmoji').value.trim(),
        systemPrompt: el('ollamaSystemPrompt').value,
        trigger: el('ollamaTrigger').value.trim(),
        contextMessages: Number(el('ollamaContextMessages').value),
        keepAlive: el('ollamaKeepAlive').value.trim(),
        numPredict: Number(el('ollamaNumPredict').value),
        requestTimeoutMs: Number(el('ollamaTimeoutSec').value) * 1000,
        tools: el('ollamaTools').checked,
        actions: el('ollamaActions').checked,
      },
    });
    await loadAll();
    renderOllamaSection();
    toast('Ollama settings saved');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

el('testOllamaBtn').addEventListener('click', async () => {
  const btn = el('testOllamaBtn');
  const out = el('ollamaTestResult');
  out.classList.add('hidden');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Testing…';
  try {
    const { reply, ms } = await api.testOllama();
    out.textContent = `✅ Replied in ${(ms / 1000).toFixed(1)}s — “${reply}”`;
  } catch (err) {
    out.textContent = `⚠️ ${err.message}`;
  } finally {
    out.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ---------- Code workspace ----------
// Config only — sessions, transcript and per-session model switching all live
// in the Code view itself. Mirrors the Ollama section's shape; the enabled
// toggle mirrors service control's "needs a password first" gate.

let codeModelsLoaded = false;

function renderCodeSection() {
  const c = state.config.code;
  const authOn = !!state.config.auth?.enabled;
  el('codeEnabled').checked = !!c.enabled;
  el('codeEnabled').disabled = !authOn && !c.enabled;
  el('codeAuthWarning').classList.toggle('hidden', authOn);
  el('codeWorkspacePathInput').value = c.workspacePath || '';
  el('codeContextFileName').value = c.contextFileName ?? 'AGENTS.md';
  el('codeMemoryFileName').value = c.memoryFileName ?? 'AGENTS-memory.md';
  el('codeDefaultApprovalMode').value = c.defaultApprovalMode || 'ask';
  el('codeMaxSteps').value = c.maxSteps ?? 25;
  el('codeContextTokens').value = c.contextTokens ?? 16384;
  el('codeCompactAtPercent').value = c.compactAtPercent ?? 75;
  el('codeTimeoutSec').value = Math.round((c.requestTimeoutMs || 300000) / 1000);
  el('codeVisionTimeoutSec').value = Math.round((c.visionTimeoutMs || 240000) / 1000);
  renderCodeToolList();
  el('codeAllowCommands').checked = !!c.allowCommands;
  el('codeAllowCommands').disabled = !authOn && !c.allowCommands;
  el('codeCommandsWarning').classList.toggle('hidden', authOn);
  el('codeCommandTimeoutSec').value = Math.round((c.commandTimeoutMs || 60000) / 1000);
  el('codeChecks').value = (c.checks || []).map((x) => `${x.label}: ${x.command}`).join('\n');
  el('codeCheckTimeoutSec').value = Math.round((c.checkTimeoutMs || 120000) / 1000);
  el('codeRulesAllow').value = (c.commandRules?.allow || []).join('\n');
  el('codeRulesDeny').value = (c.commandRules?.deny || []).join('\n');
  el('codeModelsError').classList.add('hidden');
  el('codeSaveError').classList.add('hidden');
}

// Whitespace-split a textarea into a trimmed, blank-free line list.
function parseRuleLines(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The optional-tool checklist (Code parity roadmap 2a). The full set is
// fetched once from the server (it's the source of truth for tool names);
// a box is ticked when the tool is NOT in config.code.disabledTools.
let codeToolInfo = null;
let codeDefaultDeny = null; // seeded never-run list, for the "restore defaults" button (2b)
async function renderCodeToolList() {
  const host = el('codeToolList');
  if (!host) return;
  if (!codeToolInfo) {
    try {
      const { tools, defaultDenyRules } = await api.getCodeTools();
      codeToolInfo = Array.isArray(tools) ? tools : [];
      codeDefaultDeny = Array.isArray(defaultDenyRules) ? defaultDenyRules : [];
    } catch {
      host.innerHTML = '<p class="settings-hint">Couldn\'t load the tool list.</p>';
      return;
    }
  }
  const off = new Set(state.config.code?.disabledTools || []);
  host.innerHTML = codeToolInfo
    .map(
      (t) => `<label class="checkbox-row">
        <input type="checkbox" data-code-tool="${escapeAttr(t.name)}"${off.has(t.name) ? '' : ' checked'} />
        ${escapeHtml(t.label)} <code>${escapeHtml(t.name)}</code>
      </label>`
    )
    .join('');
}

// One check per line: "label: command". Split on the first colon; a line with
// no colon becomes a command labelled by its first word.
function parseChecks(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      if (i === -1) return { label: line.split(/\s+/)[0] || 'check', command: line };
      return { label: line.slice(0, i).trim() || 'check', command: line.slice(i + 1).trim() };
    })
    .filter((x) => x.command);
}

function fillModelSelect(select, models, saved, blankLabel) {
  select.innerHTML =
    `<option value="">${blankLabel}</option>` +
    models
      .map((m) => {
        const label = m.parameterSize ? `${m.name} (${m.parameterSize})` : m.name;
        return `<option value="${escapeAttr(m.name)}"${m.name === saved ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      })
      .join('');
  if (saved && !models.some((m) => m.name === saved)) {
    select.insertAdjacentHTML(
      'afterbegin',
      `<option value="${escapeAttr(saved)}" selected>${escapeHtml(saved)} — not installed</option>`
    );
  }
}

async function loadCodeModels() {
  const select = el('codeDefaultModel');
  const errEl = el('codeModelsError');
  const saved = state.config.code.defaultModel;
  errEl.classList.add('hidden');
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const { models } = await api.getOllamaModels();
    fillModelSelect(select, models, saved, '(none — choose per session)');
    fillModelSelect(el('codeVisionModel'), models, state.config.code.visionModel || '', '(none — attached images get a note)');
    codeModelsLoaded = true;
    refreshVisionBadge();
  } catch (err) {
    select.innerHTML = `<option value="${escapeAttr(saved)}" selected>${escapeHtml(saved || '(none selected)')}</option>`;
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// Ask the server whether the currently-picked vision model actually reports the
// `vision` capability (Code parity 4b) — a live ✓ / ⚠ under the dropdown.
async function refreshVisionBadge() {
  const badge = el('codeVisionBadge');
  const model = el('codeVisionModel').value;
  if (!model) {
    badge.textContent = 'No vision model — attached images will just get a "no vision model" note.';
    badge.classList.remove('login-error');
    return;
  }
  badge.textContent = 'checking…';
  badge.classList.remove('login-error');
  try {
    const info = await api.getCodeModelInfo(model);
    if (info.vision) {
      badge.textContent = `✓ ${model} reports vision support.`;
      badge.classList.remove('login-error');
    } else {
      badge.textContent = `⚠ ${model} does not report vision support — it may not be able to read images.`;
      badge.classList.add('login-error');
    }
  } catch {
    badge.textContent = `Couldn't check ${model} (is it pulled? is Ollama up?).`;
    badge.classList.remove('login-error');
  }
}

el('refreshCodeModelsBtn').addEventListener('click', loadCodeModels);
el('refreshCodeModelsBtn2').addEventListener('click', loadCodeModels);
el('codeVisionModel').addEventListener('change', refreshVisionBadge);

// Refill the never-run box with the shipped defaults (Code parity 2b). Merges
// rather than replaces, so anything the user added stays. Not saved until they
// hit Save Code settings.
el('codeRulesResetDeny').addEventListener('click', async () => {
  if (!codeDefaultDeny) {
    try {
      const { defaultDenyRules } = await api.getCodeTools();
      codeDefaultDeny = Array.isArray(defaultDenyRules) ? defaultDenyRules : [];
    } catch {
      toast('Could not load the default list', true);
      return;
    }
  }
  const current = parseRuleLines(el('codeRulesDeny').value);
  const merged = [...new Set([...current, ...codeDefaultDeny])];
  el('codeRulesDeny').value = merged.join('\n');
  toast('Default never-run patterns added — Save to keep them');
});

el('saveCodeBtn').addEventListener('click', async () => {
  const errEl = el('codeSaveError');
  errEl.classList.add('hidden');
  const payload = {
    enabled: el('codeEnabled').checked,
    workspacePath: el('codeWorkspacePathInput').value.trim(),
    contextFileName: el('codeContextFileName').value.trim(),
    memoryFileName: el('codeMemoryFileName').value.trim(),
    defaultApprovalMode: el('codeDefaultApprovalMode').value,
    maxSteps: Number(el('codeMaxSteps').value),
    contextTokens: Number(el('codeContextTokens').value),
    compactAtPercent: Number(el('codeCompactAtPercent').value),
    disabledTools: [...document.querySelectorAll('#codeToolList input[data-code-tool]')]
      .filter((cb) => !cb.checked)
      .map((cb) => cb.dataset.codeTool),
    allowCommands: el('codeAllowCommands').checked,
    commandRules: {
      allow: parseRuleLines(el('codeRulesAllow').value),
      deny: parseRuleLines(el('codeRulesDeny').value),
    },
    commandTimeoutMs: Number(el('codeCommandTimeoutSec').value) * 1000,
    checks: parseChecks(el('codeChecks').value),
    checkTimeoutMs: Number(el('codeCheckTimeoutSec').value) * 1000,
    requestTimeoutMs: Number(el('codeTimeoutSec').value) * 1000,
    visionTimeoutMs: Number(el('codeVisionTimeoutSec').value) * 1000,
  };
  // Only send the model picks if the list actually loaded — otherwise an empty
  // select would silently clear a saved choice.
  if (codeModelsLoaded) {
    payload.defaultModel = el('codeDefaultModel').value;
    payload.visionModel = el('codeVisionModel').value;
  }
  try {
    await api.updateSettings({ code: payload });
    await loadAll();
    renderCodeSection();
    renderAuthSection();
    toast('Code settings saved');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---------- Snippets (creative roadmap Phase 2) ----------
// A saved list of shell commands with Run buttons, plus a shipped catalog of
// ready-made ones. Editing the list needs a password; running one needs the
// switch on too (server-enforced). The list + switch persist through
// /api/snippets, separate from the main settings route.

const snip = {
  snippets: [],
  runner: { enabled: false, timeoutMs: 60000 },
  catalog: null,
  hostPlatform: '',
  loaded: false,
  results: new Map(), // id -> { exitCode, stdout, stderr, timedOut, ms } from the last run
  catalogOpen: false,
};

let snippetsLoaded = false;

const PLATFORM_LABEL = { win: 'Windows', unix: 'macOS / Linux' };
function platformMatch(entryPlatform, host) {
  if (!entryPlatform || entryPlatform === 'any') return true;
  if (entryPlatform === 'win') return host === 'win32';
  if (entryPlatform === 'unix') return host === 'linux' || host === 'darwin';
  return true;
}

async function loadSnippets() {
  try {
    const data = await api.getSnippets();
    snip.snippets = data.snippets || [];
    snip.runner = data.runner || { enabled: false, timeoutMs: 60000 };
    snip.catalog = data.catalog || { checks: [], snippets: [] };
    snip.hostPlatform = data.hostPlatform || '';
    snip.loaded = true;
  } catch (err) {
    toast(err.message, true);
  }
  renderSnippetsSection();
}

function newSnippetId() {
  return `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function renderSnippetsSection() {
  const listEl = el('snippetList');
  if (!listEl) return;
  const authOn = !!state.config?.auth?.enabled;

  el('snippetRunnerEnabled').checked = !!snip.runner.enabled;
  el('snippetRunnerEnabled').disabled = !authOn && !snip.runner.enabled;
  el('snippetRunnerAuthWarning').classList.toggle('hidden', authOn);
  el('snippetTimeoutSec').value = Math.round((snip.runner.timeoutMs || 60000) / 1000);

  const canRun = !!snip.runner.enabled && authOn;
  listEl.innerHTML = snip.snippets.map((s, i) => {
    const r = snip.results.get(s.id);
    const out = r
      ? `<pre class="snippet-output ${r.exitCode === 0 && !r.timedOut ? 'ok' : 'bad'}">${escapeHtml(
          `${r.timedOut ? '⏱ timed out' : `exit ${r.exitCode}`} · ${r.ms} ms\n\n${(r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '')}`.trim()
        )}</pre>`
      : '';
    return `
      <div class="snippet-row" data-i="${i}">
        <div class="snippet-row-fields">
          <input class="snippet-label" placeholder="Label" value="${escapeAttr(s.label)}" maxlength="60" />
          <input class="snippet-cwd" placeholder="Working dir (optional)" value="${escapeAttr(s.cwd || '')}" maxlength="400" title="Where the command runs — absolute, or relative to the Code workspace. Blank = the workspace root." />
        </div>
        <textarea class="snippet-command" placeholder="Command" rows="1" maxlength="800">${escapeHtml(s.command)}</textarea>
        <div class="snippet-row-actions">
          <button type="button" class="btn ghost snippet-run" ${canRun ? '' : 'disabled'} title="${canRun ? 'Save and run' : 'Turn the runner on to run'}">▶ Run</button>
          <button type="button" class="btn ghost snippet-remove">Remove</button>
        </div>
        ${out}
      </div>`;
  }).join('') || '<p class="settings-hint">No snippets yet — add one below, or from the catalog.</p>';

  // field edits → keep snip.snippets in sync (no re-render, so focus stays)
  listEl.querySelectorAll('.snippet-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.snippet-label').addEventListener('input', (e) => { snip.snippets[i].label = e.target.value; });
    row.querySelector('.snippet-cwd').addEventListener('input', (e) => { snip.snippets[i].cwd = e.target.value; });
    row.querySelector('.snippet-command').addEventListener('input', (e) => { snip.snippets[i].command = e.target.value; });
    row.querySelector('.snippet-remove').addEventListener('click', () => {
      snip.snippets.splice(i, 1);
      renderSnippetsSection();
    });
    row.querySelector('.snippet-run').addEventListener('click', () => runOneSnippet(snip.snippets[i]));
  });

  renderSnippetCatalog();
}

async function runOneSnippet(s) {
  if (!s.label.trim() || !s.command.trim()) return toast('Give the snippet a label and a command first', true);
  const btn = el('snippetList').querySelector(`.snippet-row[data-i="${snip.snippets.indexOf(s)}"] .snippet-run`);
  if (btn) { btn.disabled = true; btn.textContent = '… running'; }
  try {
    // Save the whole list first so the server runs exactly what's on screen.
    await persistSnippets();
    const result = await api.runSnippet(s.id);
    snip.results.set(s.id, result);
  } catch (err) {
    toast(err.message, true);
  } finally {
    renderSnippetsSection();
  }
}

async function persistSnippets() {
  const clean = snip.snippets
    .map((s) => ({ id: s.id || newSnippetId(), label: (s.label || '').trim(), command: (s.command || '').trim(), cwd: (s.cwd || '').trim() }))
    .filter((s) => s.label && s.command);
  const { snippets, runner } = await api.saveSnippets(clean, {
    enabled: el('snippetRunnerEnabled').checked,
    timeoutMs: Number(el('snippetTimeoutSec').value) * 1000,
  });
  snip.snippets = snippets;
  snip.runner = runner;
}

function renderSnippetCatalog() {
  const wrap = el('snippetCatalog');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !snip.catalogOpen);
  el('toggleCatalogBtn').textContent = snip.catalogOpen ? 'Hide the catalog' : 'Browse the catalog';
  if (!snip.catalogOpen || !snip.catalog) { wrap.innerHTML = ''; return; }

  const group = (title, entries, kind) => `
    <h4 class="snippet-catalog-heading">${title}</h4>
    ${entries.map((e) => {
      const ok = platformMatch(e.platform, snip.hostPlatform);
      const already = kind === 'check'
        ? (state.config.code?.checks || []).some((c) => c.command === e.command)
        : snip.snippets.some((s) => s.command === e.command);
      return `
        <div class="snippet-catalog-entry">
          <div class="snippet-catalog-meta">
            <span class="snippet-catalog-label">${escapeHtml(e.label)}${
              !ok ? ` <span class="snippet-plat">${PLATFORM_LABEL[e.platform] || e.platform} only</span>` : ''
            }</span>
            <span class="snippet-catalog-desc">${escapeHtml(e.description || '')}</span>
            <code class="snippet-catalog-cmd">${escapeHtml(e.command)}</code>
          </div>
          <button type="button" class="btn ghost snippet-catalog-add" data-kind="${kind}" data-id="${escapeAttr(e.id)}" ${already ? 'disabled' : ''}>${already ? 'Added' : 'Add'}</button>
        </div>`;
    }).join('')}`;

  wrap.innerHTML =
    group('Checks — for the coding agent', snip.catalog.checks || [], 'check') +
    group('Snippets — for the runner above', snip.catalog.snippets || [], 'snippet');

  wrap.querySelectorAll('.snippet-catalog-add').forEach((btn) => {
    btn.addEventListener('click', () => addFromCatalog(btn.dataset.kind, btn.dataset.id));
  });
}

async function addFromCatalog(kind, id) {
  const list = kind === 'check' ? snip.catalog.checks : snip.catalog.snippets;
  const entry = (list || []).find((e) => e.id === id);
  if (!entry) return;

  if (kind === 'check') {
    const checks = [...(state.config.code?.checks || [])];
    if (checks.some((c) => c.command === entry.command)) return;
    checks.push({ label: entry.label, command: entry.command });
    try {
      await api.updateSettings({ code: { checks } });
      await loadAll();
      renderCodeSection();
      renderSnippetCatalog();
      toast(`Added "${entry.label}" to the coding agent's checks`);
    } catch (err) {
      toast(err.message, true);
    }
  } else {
    if (snip.snippets.some((s) => s.command === entry.command)) return;
    snip.snippets.push({ id: newSnippetId(), label: entry.label, command: entry.command, cwd: '' });
    renderSnippetsSection();
    el('snippetsSaveNote').textContent = 'Added — Save to keep it';
  }
}

el('addSnippetBtn').addEventListener('click', () => {
  snip.snippets.push({ id: newSnippetId(), label: '', command: '', cwd: '' });
  renderSnippetsSection();
});

el('toggleCatalogBtn').addEventListener('click', () => {
  snip.catalogOpen = !snip.catalogOpen;
  renderSnippetCatalog();
});

el('saveSnippetsBtn').addEventListener('click', async () => {
  el('snippetsError').classList.add('hidden');
  try {
    await persistSnippets();
    renderSnippetsSection();
    el('snippetsSaveNote').textContent = 'Saved ✓';
  } catch (err) {
    el('snippetsError').textContent = err.message;
    el('snippetsError').classList.remove('hidden');
  }
});

// ---------- Scheduled tasks (ops roadmap Phase 4) ----------
// A repeating snippet / RCON command / service restart. Editing the list
// needs the normal session; whether a task actually runs is gated at fire
// time by the same switch its manual version uses (server/scheduler.js).
// The list persists through /api/schedules, separate from the main route.

const sched = {
  schedules: [],
  snippets: [],
  gameServices: [],
  restartServices: [],
  gates: { auth: false, snippetRunner: false, serviceControl: false },
  loaded: false,
};
let schedulesLoaded = false;

const newScheduleId = () => `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function loadSchedules() {
  try {
    const d = await api.getSchedules();
    sched.schedules = (d.schedules || []).map((s) => ({ ...s, action: { ...s.action } }));
    sched.snippets = d.snippets || [];
    sched.gameServices = d.gameServices || [];
    sched.restartServices = d.restartServices || [];
    sched.gates = d.gates || sched.gates;
    sched.loaded = true;
  } catch (err) {
    toast(err.message, true);
  }
  renderScheduledSection();
}

// The switch a given action depends on — used to warn when it's off.
function scheduleGateNote(action) {
  const g = sched.gates;
  if (action.type === 'snippet' && !(g.snippetRunner && g.auth)) {
    return 'the snippet runner is off — this task will be skipped';
  }
  if ((action.type === 'command' || action.type === 'restart') && !(g.serviceControl && g.auth)) {
    return 'Service Control is off — this task will be skipped';
  }
  if (action.type === 'backup' && !g.auth) {
    return 'set a password (Security tab) — folder backups need one';
  }
  if (action.type === 'wallpaper' && !g.comfy) {
    return 'ComfyUI is off — this task will be skipped';
  }
  if (action.type === 'digest' && !g.webhook) {
    return 'no alert webhook is configured (Notifications tab) — this task will be skipped';
  }
  return '';
}

function optionList(items, selected, valueKey, labelKey, placeholder) {
  const opts = items.map(
    (it) => `<option value="${escapeAttr(it[valueKey])}" ${it[valueKey] === selected ? 'selected' : ''}>${escapeHtml(it[labelKey])}</option>`
  );
  return `<option value="">${escapeHtml(placeholder)}</option>${opts.join('')}`;
}

function renderScheduledSection() {
  const listEl = el('scheduleList');
  if (!listEl) return;

  listEl.innerHTML = sched.schedules.map((s, i) => {
    const a = s.action || (s.action = { type: 'snippet' });
    const whenSpec = parseWhenClient(s.when);
    const whenHint = s.when
      ? (whenSpec.error ? `<span class="schedule-when-bad">${escapeHtml(whenSpec.error)}</span>` : `<span class="schedule-when-ok">↻ ${escapeHtml(whenSpec.text)}</span>`)
      : '';
    const gateNote = scheduleGateNote(a);
    const lr = s.lastResult;
    const lastLine = lr
      ? `<div class="schedule-last ${lr.ok ? 'ok' : 'bad'}">last: ${escapeHtml(lr.detail || '')} · ${timeAgo(lr.at)}</div>`
      : '';

    let actionFields = '';
    if (a.type === 'snippet') {
      actionFields = `<select class="schedule-action-snippet">${optionList(sched.snippets, a.snippetId, 'id', 'label', sched.snippets.length ? 'Pick a snippet…' : 'No snippets saved')}</select>`;
    } else if (a.type === 'command') {
      actionFields = `
        <select class="schedule-action-service">${optionList(sched.gameServices, a.serviceId, 'id', 'name', sched.gameServices.length ? 'Pick a game server…' : 'No game servers')}</select>
        <input class="schedule-action-command" placeholder="RCON command (e.g. say server restarting)" value="${escapeAttr(a.command || '')}" maxlength="400" />`;
    } else if (a.type === 'restart') {
      actionFields = `<select class="schedule-action-service">${optionList(sched.restartServices, a.serviceId, 'id', 'name', sched.restartServices.length ? 'Pick a service…' : 'No restartable services')}</select>`;
    } else if (a.type === 'backup') {
      actionFields = `
        <input class="schedule-backup-source" placeholder="Source folder (absolute path on the host)" value="${escapeAttr(a.sourcePath || '')}" maxlength="400" />
        <input class="schedule-backup-dest" placeholder="Destination folder" value="${escapeAttr(a.destPath || '')}" maxlength="400" />
        <input class="schedule-backup-keep" type="number" min="1" max="100" title="How many recent backups to keep" value="${a.keep || 7}" style="max-width:5rem;" />`;
    } else if (a.type === 'wallpaper') {
      const themeOpts = [{ id: '', name: 'No theme (generic)' }, ...THEMES];
      actionFields = `
        <select class="schedule-wallpaper-theme">${themeOpts.map((t) => `<option value="${escapeAttr(t.id)}" ${t.id === (a.themeId || '') ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
        <input class="schedule-wallpaper-extra" placeholder="Extra prompt (optional)" value="${escapeAttr(a.extraPrompt || '')}" maxlength="400" />`;
    } else if (a.type === 'digest') {
      actionFields = `<select class="schedule-digest-hours">
        ${[[24, 'last 24 hours'], [168, 'last 7 days'], [720, 'last 30 days']].map(([h, l]) => `<option value="${h}" ${Number(a.hours) === h ? 'selected' : ''}>${l}</option>`).join('')}
      </select>`;
    }

    return `
      <div class="schedule-row" data-i="${i}">
        <div class="schedule-row-top">
          <input class="schedule-label" placeholder="Label" value="${escapeAttr(s.label)}" maxlength="60" />
          <label class="checkbox-row schedule-enabled"><input type="checkbox" ${s.enabled ? 'checked' : ''} /> On</label>
          <button type="button" class="btn ghost schedule-run" title="Run this task now">▶ Run now</button>
          <button type="button" class="btn ghost schedule-remove">Remove</button>
        </div>
        <div class="schedule-row-when">
          <input class="schedule-when" placeholder="every 30m · daily at 03:00 · weekly on monday at 09:30" value="${escapeAttr(s.when || '')}" maxlength="40" />
          ${whenHint}
        </div>
        <div class="schedule-row-action">
          <select class="schedule-action-type">
            <option value="snippet" ${a.type === 'snippet' ? 'selected' : ''}>Run a snippet</option>
            <option value="command" ${a.type === 'command' ? 'selected' : ''}>Minecraft command</option>
            <option value="restart" ${a.type === 'restart' ? 'selected' : ''}>Restart a service</option>
            <option value="backup" ${a.type === 'backup' ? 'selected' : ''}>Back up a folder</option>
            <option value="wallpaper" ${a.type === 'wallpaper' ? 'selected' : ''}>Generate a wallpaper</option>
            <option value="digest" ${a.type === 'digest' ? 'selected' : ''}>Activity digest → webhook</option>
          </select>
          ${actionFields}
        </div>
        ${gateNote ? `<div class="schedule-gate-note">⚠ ${escapeHtml(gateNote)}</div>` : ''}
        ${lastLine}
      </div>`;
  }).join('') || '<p class="settings-hint">No scheduled tasks. Add one below.</p>';

  listEl.querySelectorAll('.schedule-row').forEach((row) => {
    const i = Number(row.dataset.i);
    const s = sched.schedules[i];
    row.querySelector('.schedule-label').addEventListener('input', (e) => { s.label = e.target.value; });
    row.querySelector('.schedule-enabled input').addEventListener('change', (e) => { s.enabled = e.target.checked; });
    row.querySelector('.schedule-when').addEventListener('input', (e) => { s.when = e.target.value; scheduleRerenderRow(i); });
    row.querySelector('.schedule-action-type').addEventListener('change', (e) => {
      const type = e.target.value;
      s.action = type === 'backup' ? { type, sourcePath: '', destPath: '', keep: 7 }
        : type === 'wallpaper' ? { type, themeId: '', extraPrompt: '' }
        : type === 'digest' ? { type, hours: 24 }
        : { type };
      renderScheduledSection();
    });
    const bind = (sel, ev, fn) => { const n = row.querySelector(sel); if (n) n.addEventListener(ev, (e) => fn(e.target.value)); };
    bind('.schedule-action-snippet', 'change', (v) => { s.action.snippetId = v; });
    bind('.schedule-action-service', 'change', (v) => { s.action.serviceId = v; });
    bind('.schedule-action-command', 'input', (v) => { s.action.command = v; });
    bind('.schedule-backup-source', 'input', (v) => { s.action.sourcePath = v; });
    bind('.schedule-backup-dest', 'input', (v) => { s.action.destPath = v; });
    bind('.schedule-backup-keep', 'input', (v) => { s.action.keep = Number(v) || 7; });
    bind('.schedule-wallpaper-theme', 'change', (v) => { s.action.themeId = v; });
    bind('.schedule-wallpaper-extra', 'input', (v) => { s.action.extraPrompt = v; });
    bind('.schedule-digest-hours', 'change', (v) => { s.action.hours = Number(v); });
    row.querySelector('.schedule-remove').addEventListener('click', () => { sched.schedules.splice(i, 1); renderScheduledSection(); });
    row.querySelector('.schedule-run').addEventListener('click', () => runOneSchedule(i));
  });
}

// Just re-do the when-hint for one row without stealing focus from the input.
function scheduleRerenderRow(i) {
  const row = el('scheduleList').querySelector(`.schedule-row[data-i="${i}"] .schedule-row-when`);
  if (!row) return;
  const input = row.querySelector('.schedule-when');
  const val = sched.schedules[i].when;
  const spec = parseWhenClient(val);
  const hint = row.querySelector('.schedule-when-ok, .schedule-when-bad');
  if (hint) hint.remove();
  if (val) {
    const span = document.createElement('span');
    span.className = spec.error ? 'schedule-when-bad' : 'schedule-when-ok';
    span.textContent = spec.error ? spec.error : `↻ ${spec.text}`;
    row.appendChild(span);
  }
  input.focus();
}

// A tiny client mirror of scheduler.js#parseWhen — just enough to preview the
// schedule as you type. The server re-parses authoritatively on save.
function parseWhenClient(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { error: '' };
  let m = s.match(/^every (\d+) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (m) {
    const n = Number(m[1]);
    const isH = /^h/.test(m[2]);
    const mins = isH ? n * 60 : n;
    if (mins < 5) return { error: 'shortest is every 5 minutes' };
    if (mins > 7 * 24 * 60) return { error: 'longer than a week — use weekly' };
    return { text: isH ? `every ${n}h` : `every ${n}m` };
  }
  m = s.match(/^daily at (\d{1,2}):(\d{2})$/);
  if (m) {
    if (Number(m[1]) > 23 || Number(m[2]) > 59) return { error: 'time out of range' };
    return { text: `daily at ${m[1].padStart(2, '0')}:${m[2]}` };
  }
  m = s.match(/^weekly on ([a-z]+) at (\d{1,2}):(\d{2})$/);
  if (m) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const short = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
    const dow = days.indexOf(m[1]) !== -1 ? days.indexOf(m[1]) : short[m[1]];
    if (dow === undefined) return { error: `"${m[1]}" isn't a day` };
    if (Number(m[2]) > 23 || Number(m[3]) > 59) return { error: 'time out of range' };
    return { text: `weekly on ${days[dow]} at ${m[2].padStart(2, '0')}:${m[3]}` };
  }
  return { error: 'use "every 30m", "daily at 03:00", or "weekly on monday at 09:30"' };
}

async function persistSchedules() {
  const { schedules, gates } = await api.saveSchedules(sched.schedules);
  sched.schedules = (schedules || []).map((s) => ({ ...s, action: { ...s.action } }));
  if (gates) sched.gates = gates;
}

async function runOneSchedule(i) {
  const s = sched.schedules[i];
  if (!s.label.trim()) return toast('Give the task a label first', true);
  const btn = el('scheduleList').querySelector(`.schedule-row[data-i="${i}"] .schedule-run`);
  if (btn) { btn.disabled = true; btn.textContent = '… running'; }
  try {
    await persistSchedules(); // run exactly what's on screen
    const { lastResult } = await api.runSchedule(s.id);
    const live = sched.schedules.find((x) => x.id === s.id);
    if (live) { live.lastResult = lastResult; live.lastRun = lastResult?.at || live.lastRun; }
    toast(lastResult?.ok ? 'Task ran' : `Task: ${lastResult?.detail || 'see result'}`, !lastResult?.ok);
  } catch (err) {
    toast(err.message, true);
  } finally {
    renderScheduledSection();
  }
}

el('addScheduleBtn').addEventListener('click', () => {
  sched.schedules.push({ id: newScheduleId(), label: '', when: '', action: { type: 'snippet' }, enabled: true, lastRun: null, lastResult: null });
  renderScheduledSection();
});

el('saveSchedulesBtn').addEventListener('click', async () => {
  el('schedulesError').classList.add('hidden');
  try {
    await persistSchedules();
    renderScheduledSection();
    el('schedulesSaveNote').textContent = 'Saved ✓';
  } catch (err) {
    el('schedulesError').textContent = err.message;
    el('schedulesError').classList.remove('hidden');
  }
});

// ---------- ComfyUI image generation ----------
// The Code agent + @cyn chat call ComfyUI for image assets. Phase A is just
// the connection + workflow config; the generate tool lands in Phase B.

let comfyModelsLoaded = false;
let pendingComfyMapping = null; // a not-yet-saved mapping from "Detect nodes"

function renderComfySection() {
  const c = state.config.comfy;
  if (!c) return;
  const authOn = !!state.config.auth?.enabled;
  el('comfyEnabled').checked = !!c.enabled;
  el('comfyEnabled').disabled = !authOn && !c.enabled;
  el('comfyAuthWarning').classList.toggle('hidden', authOn);
  el('comfyBaseUrl').value = c.baseUrl || '';
  el('comfyWorkflow').value = c.workflow || '';
  el('comfyDefaultNegative').value = c.defaultNegative || '';
  el('comfyPromptPrefix').value = c.promptPrefix || '';
  el('comfyPromptSuffix').value = c.promptSuffix || '';
  el('comfyDefaultWidth').value = c.defaultWidth ?? 512;
  el('comfyDefaultHeight').value = c.defaultHeight ?? 512;
  el('comfyDefaultSteps').value = c.defaultSteps ?? 20;
  el('comfyDefaultCfg').value = c.defaultCfg ?? 7;
  el('comfyTimeoutSec').value = Math.round((c.timeoutMs || 180000) / 1000);
  el('comfyEjectMin').value = c.ejectAfterMin ?? 10;
  el('comfyMaxPerTurn').value = c.maxPerTurn ?? 6;
  el('comfyOutputDir').value = c.outputDir || '';
  el('comfyModelsError').classList.add('hidden');
  el('comfySaveError').classList.add('hidden');
  el('comfyStatusResult').classList.add('hidden');
  // Show whatever mapping is saved (or was just detected) so the panel isn't
  // silent about it.
  showComfyMapping(pendingComfyMapping || c.mapping, pendingComfyMapping ? 'detected (unsaved)' : 'saved');
}

function showComfyMapping(mapping, source) {
  const out = el('comfyMappingResult');
  const fields = mapping ? Object.entries(mapping).filter(([, m]) => m && m.node) : [];
  if (!fields.length) {
    out.classList.add('hidden');
    return;
  }
  const parts = fields.map(([f, m]) => `${f} → ${m.node}${m.key ? `.${m.key}` : ''}`);
  const hasPrompt = fields.some(([f]) => f === 'prompt');
  out.textContent = `${hasPrompt ? '✅' : '⚠️ no prompt node —'} ${source}: ${parts.join('  ·  ')}`;
  out.classList.remove('hidden');
}

async function loadComfyCheckpoints() {
  const select = el('comfyModel');
  const errEl = el('comfyModelsError');
  const saved = state.config.comfy?.model || '';
  errEl.classList.add('hidden');
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const { checkpoints } = await api.getComfyCheckpoints();
    select.innerHTML =
      `<option value="">(use whatever the workflow specifies)</option>` +
      checkpoints
        .map((n) => `<option value="${escapeAttr(n)}"${n === saved ? ' selected' : ''}>${escapeHtml(n)}</option>`)
        .join('');
    if (saved && !checkpoints.includes(saved)) {
      select.insertAdjacentHTML(
        'afterbegin',
        `<option value="${escapeAttr(saved)}" selected>${escapeHtml(saved)} — not found</option>`
      );
    }
    comfyModelsLoaded = true;
  } catch (err) {
    select.innerHTML = `<option value="${escapeAttr(saved)}" selected>${escapeHtml(saved || '(none)')}</option>`;
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

el('refreshComfyModelsBtn').addEventListener('click', loadComfyCheckpoints);

el('testComfyBtn').addEventListener('click', async () => {
  const btn = el('testComfyBtn');
  const out = el('comfyStatusResult');
  out.classList.add('hidden');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Testing…';
  try {
    const s = await api.getComfyStatus();
    const gpu = s.deviceType === 'cuda' ? '🟢 GPU' : s.deviceType ? `🟡 ${s.deviceType.toUpperCase()}` : '';
    const vram = s.vramTotalMB ? `, ${(s.vramFreeMB / 1024).toFixed(1)}/${(s.vramTotalMB / 1024).toFixed(1)} GB free` : '';
    const q = s.queue ? ` · queue ${s.queue.running + s.queue.pending}` : '';
    out.textContent = `✅ ComfyUI ${s.version || ''} — ${gpu} ${s.device || ''}${vram}${q}`;
  } catch (err) {
    out.textContent = `⚠️ ${err.message}`;
  } finally {
    out.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = original;
  }
});

el('detectComfyBtn').addEventListener('click', async () => {
  const btn = el('detectComfyBtn');
  const out = el('comfyMappingResult');
  btn.disabled = true;
  try {
    const r = await api.detectComfyWorkflow(el('comfyWorkflow').value);
    pendingComfyMapping = r.mapping;
    showComfyMapping(r.mapping, `detected (unsaved) from ${r.nodeCount} nodes`);
  } catch (err) {
    out.textContent = `⚠️ ${err.message}`;
    out.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

el('saveComfyBtn').addEventListener('click', async () => {
  const errEl = el('comfySaveError');
  errEl.classList.add('hidden');
  const payload = {
    enabled: el('comfyEnabled').checked,
    baseUrl: el('comfyBaseUrl').value.trim(),
    workflow: el('comfyWorkflow').value,
    defaultNegative: el('comfyDefaultNegative').value,
    promptPrefix: el('comfyPromptPrefix').value.trim(),
    promptSuffix: el('comfyPromptSuffix').value.trim(),
    defaultWidth: Number(el('comfyDefaultWidth').value),
    defaultHeight: Number(el('comfyDefaultHeight').value),
    defaultSteps: Number(el('comfyDefaultSteps').value),
    defaultCfg: Number(el('comfyDefaultCfg').value),
    timeoutMs: Number(el('comfyTimeoutSec').value) * 1000,
    ejectAfterMin: Number(el('comfyEjectMin').value),
    maxPerTurn: Number(el('comfyMaxPerTurn').value),
    outputDir: el('comfyOutputDir').value.trim(),
  };
  if (comfyModelsLoaded) payload.model = el('comfyModel').value;
  if (pendingComfyMapping) payload.mapping = pendingComfyMapping;
  try {
    await api.updateSettings({ comfy: payload });
    pendingComfyMapping = null;
    await loadAll();
    renderComfySection();
    renderAuthSection();
    toast('ComfyUI settings saved');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---------- Jellyfin (creative roadmap Phase 4) ----------
// Connection only — now-playing + transport live in the Board view's
// 'jellyfin' widget. The API key is write-only from here: the config
// broadcast carries `hasApiKey`, never the key itself, so the field starts
// blank and a blank field on save means "keep what's saved".

function renderJellyfinSection() {
  if (!el('jellyfinBaseUrl')) return;
  const j = state.config.jellyfin || { baseUrl: '', hasApiKey: false };
  el('jellyfinBaseUrl').value = j.baseUrl || '';
  el('jellyfinApiKey').value = '';
  el('jellyfinApiKey').placeholder = j.hasApiKey ? 'a key is saved — paste a new one to replace it' : 'paste a key';
  el('jellyfinKeyHint').textContent = j.hasApiKey
    ? 'A key is stored. Leave the field blank to keep it.'
    : 'No key stored yet.';
  el('jellyfinResult').classList.add('hidden');
  el('jellyfinSaveError').classList.add('hidden');
}

el('saveJellyfinBtn').addEventListener('click', async () => {
  const errEl = el('jellyfinSaveError');
  errEl.classList.add('hidden');
  const payload = { baseUrl: el('jellyfinBaseUrl').value.trim() };
  const key = el('jellyfinApiKey').value.trim();
  if (key) payload.apiKey = key;
  try {
    await api.updateSettings({ jellyfin: payload });
    await loadAll();
    renderJellyfinSection();
    toast('Jellyfin settings saved');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

el('testJellyfinBtn').addEventListener('click', async () => {
  const out = el('jellyfinResult');
  const btn = el('testJellyfinBtn');
  out.classList.remove('hidden');
  out.textContent = 'Testing…';
  btn.disabled = true;
  try {
    const s = await api.getJellyfinStatus();
    out.textContent = s.connected
      ? `✅ ${s.serverName || 'Connected'}${s.version ? ` — Jellyfin ${s.version}` : ''}`
      : `⚠️ ${s.error}`;
  } catch (err) {
    out.textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Profile (Phase 11) ----------
// This device's display name + avatar, host-saved and synced. The name saves
// on the button; an uploaded image saves immediately (it's a file). A
// shuffled sprite is staged in `pendingSeed` until Save.

let pendingSeed = null; // a not-yet-saved sprite seed from the 🎲 button

function effectiveProfile() {
  const name = el('profileName').value.trim() || state.deviceName;
  if (pendingSeed) return { name, avatar: { kind: 'sprite', seed: pendingSeed } };
  return { name, avatar: state.myProfile?.avatar || null };
}

// Avatar generation (creative roadmap Phase 1b) — a third way to set the
// picture, alongside sprite + upload. Free text plus one optional preset
// style; the generated image goes through the same { kind: 'image', file }
// path as an upload.
const AVATAR_STYLE_CHIPS = [
  { id: '', label: 'Default' },
  { id: 'pixel-art', label: 'Pixel art' },
  { id: 'flat-vector', label: 'Flat vector' },
  { id: 'oil-painting', label: 'Oil painting' },
  { id: 'anime', label: 'Anime' },
  { id: '3d', label: '3D' },
];
let avatarStyle = '';
let avatarBusy = false;

function setAvatarProgress(text) {
  const box = el('avatarProgress');
  if (!box) return;
  box.classList.toggle('hidden', !text);
  box.textContent = text || '';
}

function renderAvatarStyleChips() {
  const wrap = el('avatarStyleChips');
  if (!wrap) return;
  wrap.innerHTML = AVATAR_STYLE_CHIPS.map((c) =>
    `<button type="button" class="avatar-style-chip ${avatarStyle === c.id ? 'active' : ''}" data-style="${c.id}">${c.label}</button>`
  ).join('');
  wrap.querySelectorAll('.avatar-style-chip').forEach((btn) => {
    btn.addEventListener('click', () => { avatarStyle = btn.dataset.style; renderAvatarStyleChips(); });
  });
}

export function renderProfileSection() {
  if (!el('profileName')) return;
  // Don't stomp what the user is typing if this fires from a WS echo.
  if (document.activeElement !== el('profileName')) el('profileName').value = state.deviceName;
  const prof = effectiveProfile();
  el('profileAvatarPreview').innerHTML = avatarMarkup(prof, prof.name);
  const hasImage = !pendingSeed && state.myProfile?.avatar?.kind === 'image';
  el('profileRemoveImageBtn').classList.toggle('hidden', !hasImage);
  el('profileSaveNote').textContent = '';

  const comfyOn = !!state.config?.comfy?.enabled;
  el('avatarGenerate').classList.toggle('hidden', !comfyOn);
  if (comfyOn) renderAvatarStyleChips();
  el('generateAvatarBtn').disabled = avatarBusy;
  el('avatarPrompt').disabled = avatarBusy;
}

el('profileName').addEventListener('input', renderProfileSection);

el('generateAvatarBtn').addEventListener('click', async () => {
  if (avatarBusy) return;
  const prompt = el('avatarPrompt').value.trim();
  if (!prompt) return toast('Describe the avatar you want', true);
  avatarBusy = true;
  renderProfileSection();
  setAvatarProgress('Starting… (a few minutes on CPU)');
  try {
    const profile = await api.generateAvatar(prompt, avatarStyle);
    state.myProfile = profile;
    state.profiles.set(state.deviceId, { name: state.deviceName, avatar: profile.avatar });
    pendingSeed = null;
    toast('Avatar generated');
  } catch (err) {
    toast(err.message, true);
  } finally {
    avatarBusy = false;
    setAvatarProgress('');
    renderProfileSection();
  }
});

el('profileShuffleBtn').addEventListener('click', () => {
  pendingSeed = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  renderProfileSection();
});

el('profileImageBtn').addEventListener('click', () => el('profileImageInput').click());
el('profileImageInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) return toast('Image must be under 4 MB', true);
  try {
    const profile = await api.uploadProfileAvatar(file);
    state.myProfile = profile;
    state.profiles.set(state.deviceId, { name: state.deviceName, avatar: profile.avatar });
    pendingSeed = null;
    renderProfileSection();
    toast('Profile picture set');
  } catch (err) {
    toast(err.message, true);
  }
});

el('profileRemoveImageBtn').addEventListener('click', async () => {
  try {
    const profile = await api.removeProfileAvatar();
    state.myProfile = profile;
    state.profiles.set(state.deviceId, { name: state.deviceName, avatar: profile.avatar });
    pendingSeed = null;
    renderProfileSection();
  } catch (err) {
    toast(err.message, true);
  }
});

el('saveProfileBtn').addEventListener('click', async () => {
  const name = el('profileName').value.trim().slice(0, 40);
  if (!name) return toast('A display name is required', true);
  const body = { name };
  // Save a shuffled sprite; or give a first-time profile a face seeded from
  // the name so it isn't blank.
  if (pendingSeed) body.avatar = { kind: 'sprite', seed: pendingSeed };
  else if (!state.myProfile?.avatar) body.avatar = { kind: 'sprite', seed: name };
  try {
    const profile = await api.updateProfile(body);
    state.myProfile = profile;
    state.deviceName = profile.name;
    setLocal('mc:deviceName', profile.name);
    state.profiles.set(state.deviceId, { name: profile.name, avatar: profile.avatar });
    pendingSeed = null;
    renderProfileSection();
    el('profileSaveNote').textContent = 'Saved ✓';
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Settings tabs ----------
// Per-device only (localStorage), same as the dashboard/files/chat layout
// switchers — which department you were last looking at isn't something
// worth syncing across devices.

function applySettingsTab(tab) {
  state.settingsTab = tab;
  setLocal('mc:settingsTab', tab);
  el('settingsTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.settings-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tabPanel === tab));
  // The model list is a network call to Ollama — only make it when someone
  // actually looks at the tab, and only once per time the modal is open (the
  // ↻ button re-fetches on demand).
  if (tab === 'ollama' && !ollamaModelsLoaded) {
    ollamaModelsLoaded = true;
    loadOllamaModels();
  }
  if (tab === 'code' && !codeModelsLoaded) {
    loadCodeModels();
  }
  if (tab === 'comfy' && !comfyModelsLoaded) {
    loadComfyCheckpoints();
  }
  if (tab === 'appearance' && !wallpapersLoaded) {
    wallpapersLoaded = true;
    loadWallpapers();
  }
  if (tab === 'snippets' && !snippetsLoaded) {
    snippetsLoaded = true;
    loadSnippets();
  }
  if (tab === 'scheduled' && !schedulesLoaded) {
    schedulesLoaded = true;
    loadSchedules();
  }
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
  renderOllamaSection();
  renderCodeSection();
  pendingComfyMapping = null;
  renderComfySection();
  pendingSeed = null;
  renderProfileSection();
  renderWallpaperSection();
  renderSnippetsSection();
  renderScheduledSection();
  renderJellyfinSection();
  ollamaModelsLoaded = false;
  codeModelsLoaded = false;
  comfyModelsLoaded = false;
  wallpapersLoaded = false;
  snippetsLoaded = false;
  schedulesLoaded = false;
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
  setLocal('mc:notificationsEnabled', String(checkbox.checked));
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
