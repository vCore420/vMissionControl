import { api } from './api.js';
import { state, el, toast, escapeHtml, escapeAttr, formatBytes, timeAgo, dragState, enableDragReorder } from './core.js';

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

el('deviceNameBtn').addEventListener('click', () => {
  const next = prompt('Your display name in chat:', state.deviceName);
  if (!next) return;
  const trimmed = next.trim().slice(0, 40);
  if (!trimmed) return;
  state.deviceName = trimmed;
  localStorage.setItem('mc:deviceName', trimmed);
  renderDeviceNameLabel();
});

export function renderChatBadge() {
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

export function renderChatChannels() {
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

export async function switchChannel(channelId) {
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

export function renderChatMessages() {
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
