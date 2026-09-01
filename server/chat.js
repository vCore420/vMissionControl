import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';
import { isTextByName, looksBinary } from './textFiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, 'data', 'chat-uploads');

// In-memory only, same choice as the old clipboard and the health-status
// cache — this is for devices talking to each other right now, not a
// durable record. Attachments are real files though, so those live on disk
// under UPLOAD_DIR; whenever a message carrying one is evicted or deleted,
// its file is deleted too so the folder doesn't grow forever unbounded.
const MAX_MESSAGES_PER_CHANNEL = 200;
const messagesByChannel = new Map();

export async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

// ---------- Attachment -> assistant context (M7) ----------
// When a triggered message carries a text-ish file, the Ollama assistant
// (ollamaChat.js) gets its contents alongside the question. Anything that
// isn't plain text — images, archives, binaries — comes back as a short
// note instead, so the model knows a file is there but won't invent its
// contents. Text detection lives in textFiles.js (shared with codeAttach.js).

const ATTACHMENT_TEXT_LIMIT = 6000;

// Returns { text, truncated, name } when the attachment is readable text,
// { note } when it isn't (with why), or null when there's no attachment.
export async function readAttachmentAsContext(attachment) {
  if (!attachment) return null;
  const name = attachment.originalName || 'file';
  const isText =
    attachment.mimeType?.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/x-yaml', 'application/yaml'].includes(attachment.mimeType) ||
    isTextByName(name);
  if (!isText) {
    return { note: `${name} (${attachment.mimeType || 'unknown type'}) is attached but can't be read as text` };
  }
  try {
    // filename is server-generated (randomUUID + short ext), never a client
    // path, so there's nothing to traverse — but keep the join scoped anyway.
    const buf = await fs.readFile(path.join(UPLOAD_DIR, path.basename(attachment.filename)));
    if (looksBinary(buf)) return { note: `${name} is attached but looks binary, not text` };
    let text = buf.toString('utf-8');
    const truncated = text.length > ATTACHMENT_TEXT_LIMIT;
    if (truncated) text = text.slice(0, ATTACHMENT_TEXT_LIMIT);
    return { text, truncated, name };
  } catch {
    return { note: `${name} is attached but couldn't be read` };
  }
}

export function getMessages(channelId) {
  return messagesByChannel.get(channelId) || [];
}

async function deleteAttachmentFile(message) {
  if (!message?.attachment) return;
  try {
    await fs.unlink(path.join(UPLOAD_DIR, message.attachment.filename));
  } catch {
    // already gone — fine
  }
}

export function addMessage(channelId, { author, text, deviceId, attachment, bot = false, pending = false, error = false, action = null }) {
  const message = {
    id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    author: author || 'Anonymous',
    text: text || '',
    attachment: attachment || null,
    createdAt: new Date().toISOString(),
  };
  // Only set when present so an ordinary human message keeps its exact old
  // shape — these flags are all the Ollama assistant (ollamaChat.js) needs:
  // `bot` for its own messages, `pending` for the "thinking…" placeholder,
  // `error` for a reply that failed, `action` for a Confirm/Cancel card.
  // `deviceId` (Phase 11) ties a human message to a profile for its avatar.
  if (deviceId) message.deviceId = deviceId;
  if (bot) message.bot = true;
  if (pending) message.pending = true;
  if (error) message.error = true;
  if (action) message.action = action;

  const list = messagesByChannel.get(channelId) || [];
  list.push(message);

  let evicted = [];
  if (list.length > MAX_MESSAGES_PER_CHANNEL) {
    evicted = list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
  }
  messagesByChannel.set(channelId, list);

  Promise.all(evicted.map(deleteAttachmentFile)).catch(() => {});
  appEvents.emit('chat:message', { channelId, message });
  return message;
}

// In-place edit of a message that's already been broadcast — the Ollama
// assistant uses it to swap its "thinking…" placeholder for the finished
// reply (or an error) without a delete + re-add, which would reorder the
// channel and jump everyone's scroll position. Emits its own event so
// ws.js can relay just the changed message, not re-send the channel.
export function updateMessage(channelId, messageId, patch) {
  const list = messagesByChannel.get(channelId) || [];
  const message = list.find((m) => m.id === messageId);
  if (!message) return null;
  Object.assign(message, patch);
  appEvents.emit('chat:messageUpdated', { channelId, message });
  return message;
}

export async function deleteMessage(channelId, messageId) {
  const list = messagesByChannel.get(channelId) || [];
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return false;

  const [removed] = list.splice(idx, 1);
  await deleteAttachmentFile(removed);
  appEvents.emit('chat:messageDeleted', { channelId, messageId });
  return true;
}

// Called when a channel is deleted — clears its history and any attachment
// files that history was holding onto.
export async function deleteChannelMessages(channelId) {
  const list = messagesByChannel.get(channelId) || [];
  messagesByChannel.delete(channelId);
  await Promise.all(list.map(deleteAttachmentFile)).catch(() => {});
}
