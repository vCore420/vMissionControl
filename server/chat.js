import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';

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

export function addMessage(channelId, { author, text, attachment }) {
  const message = {
    id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    author: author || 'Anonymous',
    text: text || '',
    attachment: attachment || null,
    createdAt: new Date().toISOString(),
  };

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
