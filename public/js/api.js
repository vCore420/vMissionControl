async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${method} ${url} failed (${res.status})`);
  return data;
}

export const api = {
  getConfig: () => request('GET', '/api/config'),
  getStatus: () => request('GET', '/api/status'),

  createService: (body) => request('POST', '/api/services', body),
  updateService: (id, body) => request('PUT', `/api/services/${encodeURIComponent(id)}`, body),
  deleteService: (id) => request('DELETE', `/api/services/${encodeURIComponent(id)}`),
  checkServiceNow: (id) => request('POST', `/api/services/${encodeURIComponent(id)}/check`),
  reorderServices: (ids) => request('PUT', '/api/services/reorder', { ids }),

  createGroup: (body) => request('POST', '/api/groups', body),
  updateGroup: (id, body) => request('PUT', `/api/groups/${encodeURIComponent(id)}`, body),
  deleteGroup: (id) => request('DELETE', `/api/groups/${encodeURIComponent(id)}`),

  createConnection: (body) => request('POST', '/api/connections', body),
  deleteConnection: (id) => request('DELETE', `/api/connections/${encodeURIComponent(id)}`),

  updateSettings: (body) => request('PUT', '/api/settings', body),

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
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'failed to send message');
    return data;
  },

  listFiles: (relPath) => request('GET', `/api/files?path=${encodeURIComponent(relPath || '')}`),
  downloadUrl: (relPath) => `/api/files/download?path=${encodeURIComponent(relPath)}`,
  mkdir: (relPath) => request('POST', '/api/files/mkdir', { path: relPath }),
  deleteFile: (relPath) => request('DELETE', `/api/files?path=${encodeURIComponent(relPath)}`),
  uploadFile: async (dirPath, file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dirPath || '')}`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'upload failed');
    return data;
  },
};
