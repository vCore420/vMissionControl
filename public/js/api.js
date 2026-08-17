// Sent on every mutating request once Settings → Security has a password
// set (harmless no-op otherwise — the server only checks it when auth is
// on). A foreign origin's page can't attach a custom header to a
// cross-site fetch against this server without a CORS preflight, and this
// server never grants one, so this is a second, independent layer on top
// of the session cookie's own SameSite=Strict protection. See server/auth.js.
const CSRF_HEADERS = { 'X-Mc-Request': '1' };

// A 401 means the session is gone (never had one, or it expired) — every
// call site would otherwise need its own "redirect to login" handling, so
// it happens once here instead.
function handleAuthFailure() {
  if (!location.pathname.endsWith('/login.html')) {
    window.location.href = '/login.html';
  }
}

async function request(method, url, body) {
  const opts = { method, headers: { ...CSRF_HEADERS } };
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
  reorderServices: (ids) => request('PUT', '/api/services/reorder', { ids }),

  createGroup: (body) => request('POST', '/api/groups', body),
  updateGroup: (id, body) => request('PUT', `/api/groups/${encodeURIComponent(id)}`, body),
  deleteGroup: (id) => request('DELETE', `/api/groups/${encodeURIComponent(id)}`),

  createConnection: (body) => request('POST', '/api/connections', body),
  deleteConnection: (id) => request('DELETE', `/api/connections/${encodeURIComponent(id)}`),

  updateSettings: (body) => request('PUT', '/api/settings', body),
  testAlert: () => request('POST', '/api/settings/test-alert'),

  importConfig: (config) => request('POST', '/api/config/import', config),

  getDevices: () => request('GET', '/api/devices'),
  clearDevices: () => request('DELETE', '/api/devices'),

  getHostHealth: () => request('GET', '/api/host'),

  getDiscoveryScan: () => request('GET', '/api/discovery'),
  startDiscoveryScan: () => request('POST', '/api/discovery'),
  cancelDiscoveryScan: () => request('DELETE', '/api/discovery'),

  getChatChannels: () => request('GET', '/api/chat/channels'),
  createChatChannel: (name) => request('POST', '/api/chat/channels', { name }),
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
      headers: { ...CSRF_HEADERS },
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
  mkdir: (relPath) => request('POST', '/api/files/mkdir', { path: relPath }),
  deleteFile: (relPath) => request('DELETE', `/api/files?path=${encodeURIComponent(relPath)}`),
  moveFile: (from, to) => request('POST', '/api/files/move', { from, to }),
  getRecentUploads: () => request('GET', '/api/files/recent'),
  searchFiles: (q) => request('GET', `/api/files/search?q=${encodeURIComponent(q)}`),
  uploadFile: async (dirPath, file) => {
    const form = new FormData();
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
};
