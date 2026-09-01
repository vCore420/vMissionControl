import { api } from './api.js';
import { state, el, toast, escapeHtml, escapeAttr, formatBytes, timeAgo, dragState, enableDragReorder, setLocal } from './core.js';
import { renderMarkdown } from './markdown.js';
import { avatarMarkup } from './avatar.js';

// Chat: multiple channels, each broadcasting its history live to every
// connected device. Text/links plus an optional image or file attachment
// per message — deliberately not a replacement for the shared folder,
// which still owns moving files that aren't part of a conversation.
// Exported render functions are wired into core.js's `callbacks` by app.js
// so the WS sync engine can reach this view without core.js importing it.

const URL_ONLY_RE = /^https?:\/\/\S+$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

export function renderDeviceNameLabel() {
  el('deviceNameLabel').textContent = state.deviceName;
}

// Editing your identity now lives in Settings → Profile (name + avatar,
// host-saved and synced) rather than a bare prompt().
el('deviceNameBtn').addEventListener('click', () => {
  setLocal('mc:settingsTab', 'profile');
  el('openSettings').click();
});

// Avatar + name for a message's meta line. A human message uses its sender's
// profile (by deviceId, falling back to the name); the assistant keeps its
// emoji, no avatar.
function authorMeta(m, botEmoji) {
  if (m.bot) return `<span class="chat-message-author">${escapeHtml(botEmoji)} ${escapeHtml(m.author)}</span>`;
  const profile = m.deviceId ? state.profiles.get(m.deviceId) : null;
  return (
    avatarMarkup(profile, m.author) +
    `<span class="chat-message-author">${escapeHtml(m.author)}</span>`
  );
}

export function renderChatBadge() {
  const badge = el('chatBadge');
  badge.textContent = String(state.chatUnseen);
  badge.classList.toggle('hidden', state.chatUnseen === 0);
}

// ---------- Ollama assistant toggle ----------
// A global on/off (config.ollama.active) — flipping it here persists it and
// preloads/evicts the model server-side, and the config broadcast then
// updates this button on every other open device. `renderChatAiToggle` is
// called from app.js's render() so it re-runs on boot and on every config
// change; the status poll only runs while the assistant is on.

// The assistant's name/face in a given channel: the channel's own persona
// override (set from the Edit-channel modal) falls back to the global
// Settings -> Ollama values, then a hard default. Mirrors personaFor() in
// server/ollamaChat.js.
function channelPersona(channelId) {
  const o = state.config?.ollama || {};
  const ov = (state.config?.chatChannels || []).find((c) => c.id === channelId)?.ollama || {};
  return {
    botName: ov.botName || o.botName || 'Ollama',
    botEmoji: ov.botEmoji || o.botEmoji || '🦙',
  };
}

let aiStatus = null;
let aiStatusTimer = null;

function applyAiStatusText() {
  const btn = el('chatAiToggle');
  const label = btn.querySelector('.chat-ai-toggle-text');
  const o = state.config?.ollama;
  if (!o?.active) return;
  btn.classList.remove('warn');
  if (!aiStatus) { label.textContent = 'Assistant starting…'; return; }
  if (!aiStatus.reachable) { label.textContent = 'Assistant unreachable'; btn.classList.add('warn'); return; }
  label.textContent = aiStatus.loaded ? 'Assistant ready' : 'Assistant starting…';
}

function stopAiStatusPoll() {
  if (aiStatusTimer) { clearInterval(aiStatusTimer); aiStatusTimer = null; }
  aiStatus = null;
}

function startAiStatusPoll() {
  if (aiStatusTimer) return;
  const tick = async () => {
    if (!state.config?.ollama?.active) return;
    if (!el('chatView').classList.contains('active')) return; // no point polling a hidden view
    try {
      aiStatus = await api.getOllamaStatus();
      applyAiStatusText();
    } catch {
      /* transient — next tick retries */
    }
  };
  tick();
  aiStatusTimer = setInterval(tick, 4000);
}

export function renderChatAiToggle() {
  const btn = el('chatAiToggle');
  const o = state.config?.ollama;
  if (!btn || !o) return;
  btn.querySelector('.chat-ai-toggle-face').textContent = channelPersona(state.activeChannelId).botEmoji;
  btn.classList.toggle('on', !!o.active);
  btn.setAttribute('aria-checked', String(!!o.active));
  const label = btn.querySelector('.chat-ai-toggle-text');

  if (!o.model) {
    btn.disabled = true;
    btn.classList.remove('on', 'warn');
    label.textContent = 'Assistant — needs setup';
    btn.title = 'Choose a model in Settings → Ollama first';
    stopAiStatusPoll();
    return;
  }

  btn.disabled = false;
  btn.title = o.active ? 'Turn the Ollama assistant off' : 'Turn the Ollama assistant on';

  if (!o.active) {
    btn.classList.remove('warn');
    label.textContent = 'Assistant off';
    stopAiStatusPoll();
    return;
  }

  applyAiStatusText();
  startAiStatusPoll();
}

el('chatAiToggle').addEventListener('click', async () => {
  const btn = el('chatAiToggle');
  const next = !state.config.ollama.active;
  btn.disabled = true;
  try {
    aiStatus = await api.setOllamaActive(next);
    state.config.ollama.active = next; // optimistic; the config broadcast will confirm
    renderChatAiToggle();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function applyLocalChannelReorder(ids) {
  const byId = new Map((state.config.chatChannels || []).map((c) => [c.id, c]));
  const idSet = new Set(ids);
  let cursor = 0;
  state.config.chatChannels = (state.config.chatChannels || []).map((c) => (idSet.has(c.id) ? byId.get(ids[cursor++]) : c));
}

export function renderChatChannels() {
  const wrap = el('chatChannelTabs');
  const channels = state.config.chatChannels || [];
  const canDelete = channels.length > 1;

  wrap.innerHTML = channels.map((c) => `
    <div class="chat-channel-tab ${c.id === state.activeChannelId ? 'active' : ''}" data-id="${c.id}" draggable="true">
      <span class="channel-select">${escapeHtml(c.name)}${c.ollama ? ' <span class="channel-persona-dot" title="Has its own assistant personality"></span>' : ''}</span>
      <button class="edit-channel-btn" title="Edit channel">✎</button>
      ${canDelete ? `<button class="delete-channel-btn" title="Delete channel">✕</button>` : ''}
    </div>
  `).join('') + `<button type="button" class="chat-channel-tab add-channel" id="addChannelBtn" title="New channel">＋</button>`;

  wrap.querySelectorAll('.chat-channel-tab[data-id]').forEach((tab) => {
    const id = tab.dataset.id;
    tab.querySelector('.channel-select').addEventListener('click', () => switchChannel(id));
    tab.querySelector('.edit-channel-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openChannelModal(id);
    });
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
      dragState.originContainer = wrap;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id); // required by Firefox to start a drag
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      dragState.originContainer = null;
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

// ---------- Edit channel (rename + per-channel assistant persona) ----------

const channelModal = el('channelModal');
const channelForm = el('channelForm');

function openChannelModal(channelId) {
  const channel = (state.config.chatChannels || []).find((c) => c.id === channelId);
  if (!channel) return;
  channelForm.dataset.channelId = channelId;
  channelForm.elements.name.value = channel.name;
  channelForm.elements.botName.value = channel.ollama?.botName || '';
  channelForm.elements.botEmoji.value = channel.ollama?.botEmoji || '';
  channelForm.elements.systemPrompt.value = channel.ollama?.systemPrompt || '';
  channelModal.classList.remove('hidden');
  channelForm.elements.name.focus();
}

function closeChannelModal() {
  channelModal.classList.add('hidden');
}

channelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api.updateChatChannel(e.target.dataset.channelId, {
      name: f.name.value.trim(),
      // Empty strings clear that field back to the global default (server-side).
      ollama: {
        botName: f.botName.value.trim(),
        botEmoji: f.botEmoji.value.trim(),
        systemPrompt: f.systemPrompt.value,
      },
    });
    closeChannelModal();
    // the config broadcast re-renders the tabs + messages
  } catch (err) {
    toast(err.message, true);
  }
});

el('cancelChannelBtn').addEventListener('click', closeChannelModal);
channelModal.addEventListener('click', (e) => { if (e.target === channelModal) closeChannelModal(); });

// The single place `#chatLayout`'s class list is set — the layout mode
// (tabs / sidebar / floating) plus, for the two side-by-side modes, whether
// the channel column is collapsed. Both are per-device (localStorage), same
// as every other view switcher. Called from the layout switch, the collapse
// toggle, and app.js's boot.
export function applyChatLayoutClasses() {
  el('chatLayout').className =
    `chat-layout mode-${state.chatViewMode}${state.chatChannelsCollapsed ? ' channels-collapsed' : ''}`;
}

// Drives both the outer layout chrome and the message bubble style, which
// piggybacks on Tabs vs. everything-else: Sidebar and Floating both read as
// "AI chat interface", so both use the bubble treatment; only Tabs keeps
// the original flat author/time layout.
function applyChatLayoutMode(mode) {
  state.chatViewMode = mode;
  setLocal('mc:chatView', mode);
  el('chatLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
  applyChatLayoutClasses();
  renderChatMessages();
}

el('chatLayoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  applyChatLayoutMode(btn.dataset.layout);
});

// Collapse / expand the channel column (sidebar + floating layouts). The
// toggle button lives in the chat header and is CSS-hidden in Tabs mode,
// where the channels are already a bar across the top.
el('chatChannelsToggle').addEventListener('click', () => {
  state.chatChannelsCollapsed = !state.chatChannelsCollapsed;
  setLocal('mc:chatChannelsCollapsed', String(state.chatChannelsCollapsed));
  applyChatLayoutClasses();
});

export async function switchChannel(channelId) {
  state.activeChannelId = channelId;
  const channel = (state.config.chatChannels || []).find((c) => c.id === channelId);
  el('chatChannelTitle').textContent = channel ? channel.name : '';
  renderChatChannels();
  renderChatAiToggle(); // the assistant's face can differ per channel

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

export function renderChatMessages() {
  const list = el('chatMessages');
  const messageStyle = state.chatViewMode === 'tabs' ? 'default' : 'bubbles';
  list.className = `chat-messages mode-${messageStyle}`;
  const messages = state.chatMessages.get(state.activeChannelId) || [];
  el('chatEmptyState').classList.toggle('hidden', messages.length > 0);
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  const botEmoji = channelPersona(state.activeChannelId).botEmoji;

  list.innerHTML = messages.map((m) => {
    const mine = m.deviceId ? m.deviceId === state.deviceId : m.author === state.deviceName;
    const cls = ['chat-message', mine ? 'own' : 'other'];
    if (m.bot) cls.push('bot');
    if (m.error) cls.push('error');
    if (m.pending) cls.push('pending');
    const author = authorMeta(m, botEmoji);

    if (m.pending) {
      // No text yet → waiting on the first token ("thinking" + dots).
      // Text arriving → render it live (Markdown, same as a finished reply)
      // with a blinking cursor so it reads as still typing.
      const streamingBody = m.text.trim()
        ? `<div class="chat-message-text md">${renderMarkdown(m.text)}<span class="stream-cursor"></span></div>`
        : `<div class="chat-thinking">thinking<span class="thinking-dots"><i></i><i></i><i></i></span></div>`;
      return `
        <div class="${cls.join(' ')}" data-id="${m.id}">
          <div class="chat-message-meta">${author}</div>
          ${streamingBody}
        </div>`;
    }

    if (m.action) {
      const a = m.action;
      const statusLine = {
        pending: '',
        running: `<span class="chat-action-state">${escapeHtml(a.detail || 'running…')}</span>`,
        done: `<span class="chat-action-state ok">✅ ${escapeHtml(a.detail || 'done')}</span>`,
        failed: `<span class="chat-action-state fail">⚠️ ${escapeHtml(a.detail || 'failed')}</span>`,
        cancelled: '<span class="chat-action-state">cancelled</span>',
        expired: '<span class="chat-action-state">expired — ask again</span>',
      }[a.status] || '';
      const buttons = a.status === 'pending'
        ? `<div class="chat-action-buttons">
             <button class="btn primary" data-action-decide="confirm" data-action-id="${escapeAttr(a.id)}">Confirm</button>
             <button class="btn ghost" data-action-decide="cancel" data-action-id="${escapeAttr(a.id)}">Cancel</button>
           </div>`
        : '';
      return `
        <div class="${cls.join(' ')}" data-id="${m.id}">
          <div class="chat-message-meta">${author}</div>
          <div class="chat-action-card ${escapeAttr(a.status)}">
            <div class="chat-action-summary">⚡ ${escapeHtml(a.summary)}</div>
            ${statusLine}
            ${buttons}
          </div>
        </div>`;
    }

    const trimmed = m.text.trim();
    // The assistant's own replies get lightweight Markdown (code blocks
    // especially — see markdown.js); a failed reply (m.error) stays plain,
    // and human messages keep the original escape + whole-message-is-a-link
    // behaviour so typing *asterisks* doesn't silently turn into italics.
    let body = '';
    if (trimmed && m.bot && !m.error) {
      body = `<div class="chat-message-text md">${renderMarkdown(m.text)}</div>`;
    } else if (trimmed) {
      const linkified = URL_ONLY_RE.test(trimmed)
        ? `<a href="${escapeAttr(trimmed)}" target="_blank" rel="noopener">${escapeHtml(trimmed)}</a>`
        : escapeHtml(m.text);
      body = `<div class="chat-message-text">${linkified}</div>`;
    }

    // A small footnote on a reply that consulted live data — so it's
    // visible what the assistant looked at (server-set `toolsUsed`).
    const toolsNote = m.toolsUsed?.length
      ? `<div class="chat-tools-used">🔍 checked: ${m.toolsUsed.map(escapeHtml).join(', ')}</div>`
      : '';

    return `
      <div class="${cls.join(' ')}" data-id="${m.id}">
        <div class="chat-message-meta">
          ${author}
          <span class="chat-message-time">${timeAgo(m.createdAt)}</span>
          <button class="chat-message-delete" title="Delete">✕</button>
        </div>
        ${body}
        ${toolsNote}
        ${attachmentMarkup(m.attachment)}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.chat-message').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.chat-message-delete')?.addEventListener('click', async () => {
      try {
        await api.deleteChatMessage(state.activeChannelId, id);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  list.querySelectorAll('[data-action-decide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const actionId = btn.dataset.actionId;
      const decision = btn.dataset.actionDecide;
      btn.closest('.chat-action-buttons').querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await api.decideOllamaAction(actionId, decision);
        // the card updates in place via the chat:messageUpdated broadcast
      } catch (err) {
        toast(err.message, true);
        renderChatMessages(); // re-enable the buttons
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
