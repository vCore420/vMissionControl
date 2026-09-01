// Fires an outbound webhook when a service crosses online<->offline, so you
// find out even when nobody has the dashboard open — the in-page toast and
// desktop Notification (app.js) only reach a browser that's already looking
// at this app. Deliberately a separate transition tracker from the
// frontend's: the frontend diffs its own poll history for its own toasts,
// this diffs server-side status snapshots so it still works with zero
// browser tabs open.
//
// Also relays a curated slice of the activity log (new devices, security
// setting changes, a login lockout) through the same webhook — see
// alertActivity below and its call site in activityLog.js. Deliberately
// not *everything* logActivity sees: routine sign-ins and cosmetic
// settings tweaks would just be noise for something meant to answer "what
// do I need to know about while I'm away."

import { getContainerLogs } from './docker.js';
import { loadConfig } from './config.js';

const WEBHOOK_TIMEOUT_MS = 5000;
const prevStatusById = new Map();

// Only offline transitions get enriched — "why did this go down" is the
// question worth answering with a reason and, where possible, its own
// recent output; "it came back" doesn't need either. Real console logs
// only exist for Docker-controlled services (per Vi's own "if available"
// framing) — a script controller or a plain HTTP-monitored service has no
// log source to reach for, so this quietly returns nothing for those
// rather than pretending there's something to show.
const LOG_TAIL_LINES = 20;
const LOG_MAX_CHARS = 800;

async function fetchRecentLogsIfAvailable(service, status) {
  if (status !== 'offline') return null;
  if (service.controller?.type !== 'docker' || !service.controller.container) return null;
  try {
    const logs = (await getContainerLogs(service.controller.container, { tail: LOG_TAIL_LINES })).trim();
    if (!logs) return null;
    return logs.length > LOG_MAX_CHARS ? `…${logs.slice(-LOG_MAX_CHARS)}` : logs;
  } catch {
    return null; // best-effort enrichment — a failed log fetch shouldn't cost the alert itself
  }
}

function buildPayload(format, service, entry, timestamp, logs) {
  const status = entry.status;
  const verb = status === 'online' ? 'back online' : 'offline';
  const emoji = status === 'online' ? '🟢' : '🔴';
  const reason = status === 'offline' ? entry.error || entry.detail : null;
  const text = `${emoji} ${service.name} is ${verb}${reason ? ` — ${reason}` : ''}`;
  const logsBlock = logs ? `\n\`\`\`\n${logs}\n\`\`\`` : '';

  if (format === 'discord') return { content: `${text}\n${service.url}${logsBlock}` };
  if (format === 'slack') return { text: `${text} (${service.url})${logsBlock}` };

  // 'generic' — a full JSON payload for anyone wiring this into their own
  // automation (Home Assistant, n8n, a custom script, ...) rather than a
  // chat app expecting a specific message shape.
  return {
    event: 'service_status_change',
    service: { id: service.id, name: service.name, url: service.url },
    status,
    reason: reason || null,
    httpStatus: entry.httpStatus ?? null,
    latencyMs: entry.latencyMs ?? null,
    logs: logs || null,
    timestamp,
  };
}

async function postWebhook(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Alert failures are logged, never thrown — a broken/rate-limited webhook
// URL must not take down health checking, which everything else depends on.
async function fireAlert(config, service, entry) {
  const { webhookUrl, format } = config.alerts;
  try {
    const logs = await fetchRecentLogsIfAvailable(service, entry.status);
    await postWebhook(webhookUrl, buildPayload(format, service, entry, new Date().toISOString(), logs));
  } catch (err) {
    console.error(`[alerts] webhook failed for ${service.name}:`, err.message);
  }
}

// Same online/offline-only, ignore-if-unchanged logic as the frontend's own
// transition detector (app.js handleStatusTransitions) — 'checking' and
// 'unmonitored' are never alertable states, and a freshly-added service's
// first result is a baseline, not a transition.
const TRACKABLE = new Set(['online', 'offline']);

export function checkTransitions(snapshot, config) {
  if (!config.alerts?.enabled || !config.alerts?.webhookUrl) return;

  const entryById = new Map(snapshot.map((s) => [s.id, s]));
  for (const service of config.services) {
    const entry = entryById.get(service.id);
    const next = entry?.status;
    const prev = prevStatusById.get(service.id);
    prevStatusById.set(service.id, next);
    if (!TRACKABLE.has(prev) || !TRACKABLE.has(next) || prev === next) continue;
    fireAlert(config, service, entry).catch(() => {});
  }
}

export function forgetService(serviceId) {
  prevStatusById.delete(serviceId);
}

// ---------- Activity relay ----------
// A curated slice of activityLog.js's much broader stream — every add/
// change/remove would be far too much noise for a phone notification, but
// a new device on the network, a security setting changing, or a login
// lockout are exactly the "something happened while I was away" moments
// this whole feature exists for. Called from logActivity itself (fire-
// and-forget, same as that function's own file write) rather than requiring
// every call site that logs one of these to also remember to alert.
const ALERTABLE_AUTH_MESSAGES = new Set([
  'Password changed',
  'Password protection enabled',
  'Password protection disabled',
  'Login blocked (rate-limited)',
]);

// 'security' is *not* a blanket-alertable category the way 'device' is —
// ipAllowlist.js logs the same category for every single request it
// rejects, which could mean one misconfigured device sitting there
// retrying floods the webhook. Only the two actual setting-change lines
// (from routes/settings.js) are worth a ping; a rejected request already
// got nowhere; the log file is still the place to notice a pattern in
// those without a phone buzzing on every one.
function isAlertableActivity(category, message) {
  if (category === 'device') return true;
  if (category === 'security') return message.startsWith('Updated IP allowlist') || message.startsWith('Service control');
  if (category === 'auth') return ALERTABLE_AUTH_MESSAGES.has(message);
  return false;
}

const ACTIVITY_EMOJI = { device: '🔌', security: '🔒', auth: '🔒' };

function buildActivityPayload(format, category, message, ip) {
  const emoji = ACTIVITY_EMOJI[category] || '📋';
  const text = `${emoji} ${message}${ip ? ` (${ip})` : ''}`;
  if (format === 'discord') return { content: text };
  if (format === 'slack') return { text };
  return { event: 'activity', category, message, ip: ip || null, timestamp: new Date().toISOString() };
}

export async function alertActivity(category, message, ip) {
  if (!isAlertableActivity(category, message)) return;
  const config = await loadConfig();
  if (!config.alerts?.enabled || !config.alerts?.webhookUrl) return;
  try {
    await postWebhook(config.alerts.webhookUrl, buildActivityPayload(config.alerts.format, category, message, ip));
  } catch (err) {
    console.error(`[alerts] webhook failed for activity "${message}":`, err.message);
  }
}

function buildTestPayload(format) {
  const text = '✅ Mission Control test alert — your webhook is wired up correctly.';
  if (format === 'discord') return { content: text };
  if (format === 'slack') return { text };
  return { event: 'test_alert', message: text, timestamp: new Date().toISOString() };
}

export async function sendTestAlert(config) {
  if (!config.alerts?.webhookUrl) throw new Error('no webhook URL saved');
  await postWebhook(config.alerts.webhookUrl, buildTestPayload(config.alerts.format));
}

// A free-text message through the same webhook — for the assistant's
// send_alert action ("@cyn tell everyone the server's going down"). Doesn't
// require config.alerts.enabled (that switch only governs the automatic
// status/activity relay); a saved URL is enough for an on-purpose send.
export async function sendCustomAlert(config, text) {
  if (!config.alerts?.webhookUrl) throw new Error('no alert webhook URL is configured');
  const format = config.alerts.format;
  const body =
    format === 'discord' ? { content: text } : format === 'slack' ? { text } : { event: 'message', message: text, timestamp: new Date().toISOString() };
  await postWebhook(config.alerts.webhookUrl, body);
}
