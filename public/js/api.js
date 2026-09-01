// Sent on every mutating request once Settings → Security has a password
// set (harmless no-op otherwise — the server only checks it when auth is
// on). A foreign origin's page can't attach a custom header to a
// cross-site fetch against this server without a CORS preflight, and this
// server never grants one, so this is a second, independent layer on top
// of the session cookie's own SameSite=Strict protection. See server/auth.js.
const CSRF_HEADERS = { 'X-Mc-Request': '1' };

// Stable per-browser id (Phase 11) — keys this device's profile (name +
// avatar) server-side. Generated once, kept in localStorage. Sent on every
// request so the profile routes know whose profile is whose.
export function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem('mc:deviceId');
    if (!id) {
      id = (crypto.randomUUID?.() || `d-${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '');
      localStorage.setItem('mc:deviceId', id);
    }
  } catch {
    id = id || 'anon';
  }
  return id;
}

// A 401 means the session is gone (never had one, or it expired) — every
// call site would otherwise need its own "redirect to login" handling, so
// it happens once here instead.
function handleAuthFailure() {
  if (!location.pathname.endsWith('/login.html')) {
    window.location.href = '/login.html';
  }
}

async function request(method, url, body) {
  const opts = { method, headers: { ...CSRF_HEADERS, 'X-Mc-Device': deviceId() } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    handleAuthFailure();
    throw new Error('signed out — redirecting to login');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${method} ${url} failed (${res.status})`);
  return data;
}

export const api = {
  getConfig: () => request('GET', '/api/config'),
  getStatus: () => request('GET', '/api/status'),
  getActivity: (params) => request('GET', `/api/activity?${new URLSearchParams(params)}`),
  getHostHistory: () => request('GET', '/api/host?history=1'),

  authStatus: () => request('GET', '/api/auth/status'),
  login: (password) => request('POST', '/api/auth/login', { password }),
  logout: () => request('POST', '/api/auth/logout'),
  setPassword: (password) => request('POST', '/api/auth/password', { password }),
  disableAuth: () => request('POST', '/api/auth/disable'),
  setSessionLength: (days) => request('POST', '/api/auth/session-length', { days }),

  createService: (body) => request('POST', '/api/services', body),
  updateService: (id, body) => request('PUT', `/api/services/${encodeURIComponent(id)}`, body),
  deleteService: (id) => request('DELETE', `/api/services/${encodeURIComponent(id)}`),
  checkServiceNow: (id) => request('POST', `/api/services/${encodeURIComponent(id)}/check`),
  wakeService: (id) => request('POST', `/api/services/${encodeURIComponent(id)}/wake`),
  startService: (id) => request('POST', `/api/services/${encodeURIComponent(id)}/start`),
  stopService: (id) => request('POST', `/api/services/${encodeURIComponent(id)}/stop`),
  restartService: (id) => request('POST', `/api/services/${encodeURIComponent(id)}/restart`),
  getServiceLogs: (id, tail = 200) => request('GET', `/api/services/${encodeURIComponent(id)}/logs?tail=${tail}`),
  getDockerContainers: () => request('GET', '/api/docker/containers'),
  // Board 'docker' widget (ops roadmap Phase 2b) — act on a raw container by
  // name/id, not a service. start/stop/restart is Service-Control-gated
  // server-side; logs is read-only.
  dockerContainerAction: (name, action) =>
    request('POST', `/api/docker/containers/${encodeURIComponent(name)}/${encodeURIComponent(action)}`),
  getContainerLogs: (name, tail = 200) =>
    request('GET', `/api/docker/containers/${encodeURIComponent(name)}/logs?tail=${tail}`),
  reorderServices: (ids) => request('PUT', '/api/services/reorder', { ids }),
  gameServerStatus: (id) => request('GET', `/api/services/${encodeURIComponent(id)}/game/status`),
  gameServerCommand: (id, command) => request('POST', `/api/services/${encodeURIComponent(id)}/game/command`, { command }),

  createGroup: (body) => request('POST', '/api/groups', body),
  updateGroup: (id, body) => request('PUT', `/api/groups/${encodeURIComponent(id)}`, body),
  deleteGroup: (id) => request('DELETE', `/api/groups/${encodeURIComponent(id)}`),

  createConnection: (body) => request('POST', '/api/connections', body),
  deleteConnection: (id) => request('DELETE', `/api/connections/${encodeURIComponent(id)}`),

  updateSettings: (body) => request('PUT', '/api/settings', body),
  testAlert: () => request('POST', '/api/settings/test-alert'),

  getOllamaModels: () => request('GET', '/api/ollama/models'),
  getOllamaStatus: () => request('GET', '/api/ollama/status'),
  setOllamaActive: (active) => request('POST', '/api/ollama/active', { active }),
  testOllama: () => request('POST', '/api/ollama/test'),
  decideOllamaAction: (id, decision) => request('POST', `/api/ollama/action/${encodeURIComponent(id)}`, { decision }),

  getComfyStatus: () => request('GET', '/api/comfy/status'),
  getComfyCheckpoints: () => request('GET', '/api/comfy/checkpoints'),
  detectComfyWorkflow: (workflow) => request('POST', '/api/comfy/detect', { workflow }),

  // ---------- Generated images (creative roadmap Phase 1) ----------
  listWallpapers: () => request('GET', '/api/art/wallpapers'),
  generateWallpaper: (themeId, extraPrompt) =>
    request('POST', '/api/art/wallpapers', { themeId, extraPrompt }),
  deleteWallpaper: (id) => request('DELETE', `/api/art/wallpapers/${encodeURIComponent(id)}`),
  wallpaperImageUrl: (id) => `/api/art/wallpapers/${encodeURIComponent(id)}/image`,
  generateAvatar: (prompt, style) => request('POST', '/api/art/avatar', { prompt, style }),
  generateServiceIcon: (id, extraPrompt) =>
    request('POST', `/api/art/service-icon/${encodeURIComponent(id)}`, { extraPrompt }),
  deleteServiceIcon: (id) => request('DELETE', `/api/art/service-icon/${encodeURIComponent(id)}`),
  serviceIconUrl: (id, v) => `/api/art/service-icon/${encodeURIComponent(id)}?v=${encodeURIComponent(v || '')}`,

  // ---------- Snippets (creative roadmap Phase 2) ----------
  getSnippets: () => request('GET', '/api/snippets'),
  saveSnippets: (snippets, runner) => request('PUT', '/api/snippets', { snippets, runner }),
  runSnippet: (id) => request('POST', `/api/snippets/${encodeURIComponent(id)}/run`),

  // ---------- Scheduled tasks (ops roadmap Phase 4) ----------
  getSchedules: () => request('GET', '/api/schedules'),
  saveSchedules: (schedules) => request('PUT', '/api/schedules', { schedules }),
  runSchedule: (id) => request('POST', `/api/schedules/${encodeURIComponent(id)}/run`),

  // ---------- Board widgets (creative roadmap Phase 3) ----------
  addWidget: (widget) => request('POST', '/api/widgets', widget),
  updateWidget: (id, widget) => request('PUT', `/api/widgets/${encodeURIComponent(id)}`, widget),
  deleteWidget: (id) => request('DELETE', `/api/widgets/${encodeURIComponent(id)}`),
  reorderWidgets: (ids) => request('PUT', '/api/widgets/reorder', { ids }),
  getWidgetValue: (id) => request('GET', `/api/widgets/${encodeURIComponent(id)}/value`),

  // ---------- Jellyfin (creative roadmap Phase 4) ----------
  getJellyfinStatus: () => request('GET', '/api/jellyfin/status'),
  jellyfinNowPlaying: () => request('GET', '/api/jellyfin/now-playing'),
  jellyfinCommand: (sessionId, command) => request('POST', '/api/jellyfin/command', { sessionId, command }),
  jellyfinImageUrl: (itemId, tag) =>
    `/api/jellyfin/image/${encodeURIComponent(itemId)}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`,

  getCodeSessions: () => request('GET', '/api/code/sessions'),
  createCodeSession: (body) => request('POST', '/api/code/sessions', body || {}),
  updateCodeSession: (id, body) => request('PUT', `/api/code/sessions/${encodeURIComponent(id)}`, body),
  deleteCodeSession: (id) => request('DELETE', `/api/code/sessions/${encodeURIComponent(id)}`),
  getCodeMessages: (id) => request('GET', `/api/code/sessions/${encodeURIComponent(id)}/messages`),
  sendCodeMessage: (id, body) => request('POST', `/api/code/sessions/${encodeURIComponent(id)}/messages`, body),
  stopCodeTurn: (id) => request('POST', `/api/code/sessions/${encodeURIComponent(id)}/stop`),
  decideCodeApproval: (id, approvalId, decision) =>
    request('POST', `/api/code/sessions/${encodeURIComponent(id)}/approval/${encodeURIComponent(approvalId)}`, { decision }),
  answerCodeQuestion: (id, questionId, answer) =>
    request('POST', `/api/code/sessions/${encodeURIComponent(id)}/answer/${encodeURIComponent(questionId)}`, { answer }),
  saveCodePlan: (id, messageId) =>
    request('POST', `/api/code/sessions/${encodeURIComponent(id)}/save-plan`, { messageId }),
  revertCodeTurn: (id, messageId) =>
    request('POST', `/api/code/sessions/${encodeURIComponent(id)}/revert/${encodeURIComponent(messageId)}`),
  getCodeWorkspace: (relPath) => request('GET', `/api/code/workspace?path=${encodeURIComponent(relPath || '')}`),
  getCodeWorkspaceFiles: () => request('GET', '/api/code/workspace/files'),
  getCodeCommands: () => request('GET', '/api/code/commands'),
  getCodeWorkspaceFile: (relPath) => request('GET', `/api/code/workspace/file?path=${encodeURIComponent(relPath)}`),
  codeWorkspaceImageUrl: (relPath) => `/api/code/workspace/raw?path=${encodeURIComponent(relPath)}`,
  getCodeWorkspaceInfo: () => request('GET', '/api/code/workspace-info'),
  createCodeContextFile: () => request('POST', '/api/code/workspace/context-file'),
  getCodeModelInfo: (model) => request('GET', `/api/code/model-info?model=${encodeURIComponent(model || '')}`),
  codeMessageImageUrl: (id, file) =>
    `/api/code/sessions/${encodeURIComponent(id)}/image/${encodeURIComponent(file)}`,
  getCodeTools: () => request('GET', '/api/code/tools'),
  getCodeBackground: (id) => request('GET', `/api/code/sessions/${encodeURIComponent(id)}/background`),
  stopCodeBackground: (bgId) => request('POST', `/api/code/background/${encodeURIComponent(bgId)}/stop`),

  // ---------- Per-device profile (Phase 11) ----------
  getMyProfile: () => request('GET', '/api/profile'),
  getAllProfiles: () => request('GET', '/api/profile/all'),
  updateProfile: (body) => request('PUT', '/api/profile', body),
  removeProfileAvatar: () => request('DELETE', '/api/profile/avatar'),
  uploadProfileAvatar: async (file) => {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/profile/avatar', {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'X-Mc-Device': deviceId() },
      body: form,
    });
    if (res.status === 401) {
      handleAuthFailure();
      throw new Error('signed out — redirecting to login');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'failed to upload the image');
    return data;
  },

  importConfig: (config) => request('POST', '/api/config/import', config),

  getDevices: () => request('GET', '/api/devices'),
  clearDevices: () => request('DELETE', '/api/devices'),

  getHostHealth: () => request('GET', '/api/host'),

  getDiscoveryScan: () => request('GET', '/api/discovery'),
  startDiscoveryScan: () => request('POST', '/api/discovery'),
  cancelDiscoveryScan: () => request('DELETE', '/api/discovery'),

  getChatChannels: () => request('GET', '/api/chat/channels'),
  createChatChannel: (name) => request('POST', '/api/chat/channels', { name }),
  updateChatChannel: (id, body) => request('PUT', `/api/chat/channels/${encodeURIComponent(id)}`, body),
  deleteChatChannel: (id) => request('DELETE', `/api/chat/channels/${encodeURIComponent(id)}`),
  reorderChatChannels: (ids) => request('PUT', '/api/chat/channels/reorder', { ids }),
  getChatMessages: (channelId) => request('GET', `/api/chat/channels/${encodeURIComponent(channelId)}/messages`),
  deleteChatMessage: (channelId, messageId) =>
    request('DELETE', `/api/chat/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`),
  attachmentUrl: (filename) => `/api/chat/attachments/${encodeURIComponent(filename)}`,
  sendChatMessage: async (channelId, { author, text, file }) => {
    const form = new FormData();
    form.append('author', author);
    form.append('text', text || '');
    if (file) form.append('file', file);
    const res = await fetch(`/api/chat/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'X-Mc-Device': deviceId() },
      body: form,
    });
    if (res.status === 401) {
      handleAuthFailure();
      throw new Error('signed out — redirecting to login');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'failed to send message');
    return data;
  },

  listFiles: (relPath) => request('GET', `/api/files?path=${encodeURIComponent(relPath || '')}`),
  downloadUrl: (relPath) => `/api/files/download?path=${encodeURIComponent(relPath)}`,
  downloadZipUrl: (relPath) => `/api/files/download-zip?path=${encodeURIComponent(relPath)}`,
  mkdir: (relPath) => request('POST', '/api/files/mkdir', { path: relPath }),
  deleteFile: (relPath) => request('DELETE', `/api/files?path=${encodeURIComponent(relPath)}`),
  moveFile: (from, to) => request('POST', '/api/files/move', { from, to }),
  getRecentUploads: () => request('GET', '/api/files/recent'),
  searchFiles: (q) => request('GET', `/api/files/search?q=${encodeURIComponent(q)}`),
  // relPath (a folder-upload's File.webkitRelativePath, e.g.
  // "Vacation2026/beach.jpg") must be appended to the form *before* the
  // file — multer only has a text field in req.body by the time its
  // per-file callbacks run if it was parsed first, since a multipart body
  // is read in stream order. Omitted entirely for a plain file upload, so
  // the server falls back to its original flat-filename behavior.
  uploadFile: async (dirPath, file, relPath) => {
    const form = new FormData();
    if (relPath) form.append('relPath', relPath);
    form.append('file', file);
    const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dirPath || '')}`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS },
      body: form,
    });
    if (res.status === 401) {
      handleAuthFailure();
      throw new Error('signed out — redirecting to login');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'upload failed');
    return data;
  },

  getTimesheet: () => request('GET', '/api/timesheet'),
  saveTimesheetProfile: (fields) => request('PUT', '/api/timesheet/profile', fields),
  switchTimesheetPeriod: (periodStart) => request('PUT', '/api/timesheet/period-start', { periodStart }),
  saveTimesheetEntries: (body) => request('PUT', '/api/timesheet/entries', body),
  resetTimesheetPeriod: () => request('POST', '/api/timesheet/reset'),
  listTimesheetPeriods: () => request('GET', '/api/timesheet/periods'),
  timesheetImageUrl: (periodStart) => `/api/timesheet/periods/${encodeURIComponent(periodStart)}/image`,
  uploadTimesheetImage: async (periodStart, blob) => {
    const form = new FormData();
    form.append('image', blob, `${periodStart}.png`);
    const res = await fetch(`/api/timesheet/periods/${encodeURIComponent(periodStart)}/image`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS },
      body: form,
    });
    if (res.status === 401) {
      handleAuthFailure();
      throw new Error('signed out — redirecting to login');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'image upload failed');
    return data;
  },
};
