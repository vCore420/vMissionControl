// Server-side persistence for the Code tab's sessions — the coding agent's
// conversations. Unlike chat (in-memory, ephemeral) these are worth keeping:
// a coding session is a piece of work, not a passing message. Same cache +
// serialized-write-queue shape as server/timesheet.js, backed by its own file
// rather than config.json since the transcript grows on every turn and
// accumulates session after session.
//
// The session list is global (every device sees the same sessions, like chat
// channels); which one a device has open is that device's own choice, held in
// its localStorage, not here.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';
import { writeJsonAtomic } from './jsonStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, 'data', 'code-sessions.json');

// A backstop against a session file that grows forever. This is the on-disk
// cap; what actually gets sent to the model each turn is bounded separately in
// codeAgent.js (buildMessages drops the oldest turns past a token budget, and
// a long turn compacts its own older rounds).
const MAX_MESSAGES_PER_SESSION = 400;
const APPROVAL_MODES = new Set(['ask', 'auto-edit', 'auto-all']);

let cache = null;
let writeQueue = Promise.resolve();

async function readFromDisk() {
  try {
    return JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  } catch {
    return { sessions: [] };
  }
}

async function write() {
  writeQueue = writeQueue.then(() => writeJsonAtomic(DATA_PATH, cache));
  await writeQueue;
}

async function load() {
  if (!cache) cache = await readFromDisk();
  return cache;
}

// The shape the session sidebar needs — everything except the transcript, so
// listing every session isn't re-sending every message.
function meta(session) {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    approvalMode: session.approvalMode,
    planMode: !!session.planMode,
    // The agent's live task list (Code parity roadmap 1a) — small enough to
    // ride along with the session list so it reaches every device without a
    // separate fetch or WS message type.
    tasks: Array.isArray(session.tasks) ? session.tasks : [],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

function broadcastSessions() {
  appEvents.emit('code:sessions', { sessions: cache.sessions.map(meta) });
}

export async function listSessions() {
  const data = await load();
  return data.sessions.map(meta);
}

export async function getSession(id) {
  const data = await load();
  return data.sessions.find((s) => s.id === id) || null;
}

export async function getMessages(id) {
  const session = await getSession(id);
  return session ? session.messages : null;
}

export async function createSession({ title, model, approvalMode } = {}) {
  const data = await load();
  const now = new Date().toISOString();
  const session = {
    id: `sess-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    title: (title || '').trim().slice(0, 80) || 'New session',
    model: (model || '').trim(),
    approvalMode: APPROVAL_MODES.has(approvalMode) ? approvalMode : 'ask',
    createdAt: now,
    updatedAt: now,
    tasks: [],
    messages: [],
  };
  data.sessions.push(session);
  await write();
  broadcastSessions();
  return session;
}

export async function updateSession(id, patch) {
  const data = await load();
  const session = data.sessions.find((s) => s.id === id);
  if (!session) return null;
  if (typeof patch.title === 'string' && patch.title.trim()) session.title = patch.title.trim().slice(0, 80);
  if (typeof patch.model === 'string') session.model = patch.model.trim();
  if (APPROVAL_MODES.has(patch.approvalMode)) session.approvalMode = patch.approvalMode;
  if (typeof patch.planMode === 'boolean') session.planMode = patch.planMode;
  // Only "clear the list" is a client-side edit; the agent owns the content.
  if (Array.isArray(patch.tasks) && patch.tasks.length === 0) session.tasks = [];
  session.updatedAt = new Date().toISOString();
  await write();
  broadcastSessions();
  return session;
}

// The agent's task list for a session (Code parity roadmap 1a) — set whole
// each time by the update_tasks tool. Reuses the code:sessions broadcast, so
// every device's task panel updates without a new WS message type.
export async function setSessionTasks(id, tasks) {
  const data = await load();
  const session = data.sessions.find((s) => s.id === id);
  if (!session) return null;
  session.tasks = Array.isArray(tasks) ? tasks : [];
  session.updatedAt = new Date().toISOString();
  await write();
  broadcastSessions();
  return session;
}

export async function deleteSession(id) {
  const data = await load();
  const idx = data.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  data.sessions.splice(idx, 1);
  await write();
  broadcastSessions();
  return true;
}

export async function addMessage(
  sessionId,
  { role, author, deviceId, text, attachments, mentions, images, command, pending = false, error = false, planMode = false }
) {
  const data = await load();
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session) return null;

  const message = {
    id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    role: role || 'user',
    author: author || 'Anonymous',
    text: text || '',
    createdAt: new Date().toISOString(),
  };
  if (deviceId) message.deviceId = deviceId; // Phase 11 — profile avatar lookup
  // Only the chip metadata is kept — the attachment's text reaches the model
  // for the triggering turn only (see codeAttach.js), never persisted here.
  if (Array.isArray(attachments) && attachments.length) message.attachments = attachments;
  // @file mention chips (Code parity 3a) — like attachments, metadata only; the
  // file content is read fresh server-side for the triggering turn (codeMentions.js).
  if (Array.isArray(mentions) && mentions.length) message.mentions = mentions;
  // /command marker (Code parity 3b) — { name, source } for a transcript chip;
  // the expanded template goes to the model, not stored here.
  if (command && command.name) message.command = command;
  // Image attachments (Code parity 4a) — metadata only for the chip; the
  // vision model's description of each is what reaches the coding model.
  if (Array.isArray(images) && images.length) message.images = images;
  if (pending) message.pending = true;
  if (error) message.error = true;
  if (planMode) message.planMode = true; // a plan-mode reply — gets a "Save plan" button

  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION);
  }
  session.updatedAt = message.createdAt;
  await write();
  appEvents.emit('code:message', { sessionId, message });
  broadcastSessions();
  return message;
}

// In-place patch of a message already broadcast — the agent swapping its
// "thinking…" placeholder for streamed text, then finalising it. During a
// stream this is called a few times a second, so it only writes to disk when
// asked to (the finalising call); the cache is always current, and every
// device gets the live text over the WebSocket regardless.
export async function updateMessage(sessionId, messageId, patch, { persist = false } = {}) {
  const data = await load();
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  const message = session.messages.find((m) => m.id === messageId);
  if (!message) return null;
  Object.assign(message, patch);
  if (persist) {
    session.updatedAt = new Date().toISOString();
    await write();
  }
  appEvents.emit('code:messageUpdated', { sessionId, message });
  return message;
}
