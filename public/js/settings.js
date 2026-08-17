import { api } from './api.js';
import {
  state, el, toast, escapeHtml, escapeAttr, loadAll, timeAgo,
  healthBarClass, formatGB, formatUptime,
} from './core.js';
import { renderConnectionOverlay } from './dashboard.js';

// The Settings modal: Appearance (theme), Services (groups + health-check
// interval), Notifications, Sharing, Security (password/IP allowlist/
// service control), Devices, and Backup — plus the standalone Host Health
// modal, which lives here since it's reached from the same hero pill
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
