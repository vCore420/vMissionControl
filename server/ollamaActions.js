// Pending assistant actions awaiting a human's confirmation in chat.
//
// When the model calls an action tool (ollamaTools.js ACTION_REGISTRY),
// nothing runs — ollamaChat.js validates it here, gets back a pending
// action, and posts a Confirm/Cancel card into the channel. Only a
// confirm() from a signed-in device (the whole feature requires password
// protection) actually invokes the tool. Everything is in memory and
// ephemeral, like chat itself; a pending action that's never answered
// expires and its card goes stale.

import crypto from 'node:crypto';
import { updateMessage, addMessage } from './chat.js';
import { getActionTool } from './ollamaTools.js';
import { logActivity } from './activityLog.js';

const TTL_MS = 5 * 60 * 1000;
const pending = new Map(); // id -> { id, channelId, messageId, tool, summary, payload, requestedBy, createdAt, status }

// ollamaChat.js: validate the model's action call. Returns { error } (no
// card is shown — the model is told why) or a pending action with an id.
export async function prepareAction({ channelId, tool: toolName, args, requestedBy }) {
  const tool = getActionTool(toolName);
  if (!tool) return { error: `unknown action: ${toolName}` };

  const prep = await tool.prepare(args || {});
  if (prep.error) return { error: prep.error };

  const action = {
    id: `act-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    channelId,
    messageId: null, // set by linkMessage once the card is posted
    tool: toolName,
    summary: prep.summary,
    payload: prep.payload,
    requestedBy: requestedBy || 'someone',
    createdAt: Date.now(),
    status: 'pending',
  };
  pending.set(action.id, action);
  return { action };
}

// The card's own message id, so confirm/cancel can patch it in place.
export function linkMessage(actionId, messageId) {
  const action = pending.get(actionId);
  if (action) action.messageId = messageId;
}

// The shape embedded in the chat message and re-broadcast on every change.
function cardState(action, extra = {}) {
  return { id: action.id, tool: action.tool, summary: action.summary, status: action.status, ...extra };
}

export async function decideAction(actionId, decision, ip) {
  const action = pending.get(actionId);
  if (!action) return { error: 'that action is no longer available' };
  if (action.status !== 'pending') return { error: `this action was already ${action.status}` };
  if (Date.now() - action.createdAt > TTL_MS) {
    action.status = 'expired';
    if (action.messageId) updateMessage(action.channelId, action.messageId, { action: cardState(action) });
    pending.delete(actionId);
    return { error: 'that action expired — ask again' };
  }

  if (decision !== 'confirm') {
    action.status = 'cancelled';
    if (action.messageId) updateMessage(action.channelId, action.messageId, { action: cardState(action) });
    pending.delete(actionId);
    logActivity('chat', `Assistant action cancelled: ${action.summary}`, ip);
    return { ok: true, status: 'cancelled' };
  }

  action.status = 'running';
  if (action.messageId) updateMessage(action.channelId, action.messageId, { action: cardState(action) });

  const tool = getActionTool(action.tool);
  try {
    // A slow action (generate_image) can report progress; the card shows it
    // in place of the plain "running…".
    const onProgress = (p) => {
      if (!action.messageId) return;
      const note = p?.value != null ? `sampling ${p.value}/${p.max}…` : 'generating…';
      updateMessage(action.channelId, action.messageId, { action: cardState(action, { detail: note }) });
    };
    const result = await tool.execute(action.payload, { onProgress });
    action.status = 'done';
    const detail = result?.detail || result?.message || 'done';
    if (action.messageId) updateMessage(action.channelId, action.messageId, { action: cardState(action, { detail }) });
    // An action that produced something to show (generate_image → an image)
    // posts it as its own bot message in the channel.
    if (result?.chatMessage) addMessage(action.channelId, result.chatMessage);
    logActivity('chat', `Assistant action confirmed & run: ${action.summary} — ${detail}`, ip);
    pending.delete(actionId);
    return { ok: true, status: 'done', detail };
  } catch (err) {
    action.status = 'failed';
    if (action.messageId) updateMessage(action.channelId, action.messageId, { action: cardState(action, { detail: err.message }) });
    logActivity('chat', `Assistant action FAILED: ${action.summary} — ${err.message}`, ip);
    pending.delete(actionId);
    return { error: err.message, status: 'failed' };
  }
}

// Sweeps stale pending actions so their cards stop looking clickable.
export function initOllamaActions() {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const action of pending.values()) {
      // A confirmed action that's mid-run (a slow generate_image, say) isn't
      // stale — leave it; decideAction removes it when it finishes.
      if (action.status === 'running') continue;
      if (now - action.createdAt <= TTL_MS) continue;
      action.status = 'expired';
      if (action.messageId) updateMessage(action.channelId, action.messageId, { action: cardState(action) });
      pending.delete(action.id);
    }
  }, 60 * 1000);
  if (sweep.unref) sweep.unref();
}
