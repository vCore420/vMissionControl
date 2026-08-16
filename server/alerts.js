// Fires an outbound webhook when a service crosses online<->offline, so you
// find out even when nobody has the dashboard open — the in-page toast and
// desktop Notification (app.js) only reach a browser that's already looking
// at this app. Deliberately a separate transition tracker from the
// frontend's: the frontend diffs its own poll history for its own toasts,
// this diffs server-side status snapshots so it still works with zero
// browser tabs open.

const WEBHOOK_TIMEOUT_MS = 5000;
const prevStatusById = new Map();

function buildPayload(format, service, status, timestamp) {
  const verb = status === 'online' ? 'back online' : 'offline';
  const emoji = status === 'online' ? '🟢' : '🔴';
  const text = `${emoji} ${service.name} is ${verb}`;

  if (format === 'discord') return { content: `${text}\n${service.url}` };
  if (format === 'slack') return { text: `${text} (${service.url})` };

  // 'generic' — a full JSON payload for anyone wiring this into their own
  // automation (Home Assistant, n8n, a custom script, ...) rather than a
  // chat app expecting a specific message shape.
  return {
    event: 'service_status_change',
    service: { id: service.id, name: service.name, url: service.url },
    status,
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
async function fireAlert(config, service, status) {
  const { webhookUrl, format } = config.alerts;
  try {
    await postWebhook(webhookUrl, buildPayload(format, service, status, new Date().toISOString()));
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

  const statusById = new Map(snapshot.map((s) => [s.id, s.status]));
  for (const service of config.services) {
    const prev = prevStatusById.get(service.id);
    const next = statusById.get(service.id);
    prevStatusById.set(service.id, next);
    if (!TRACKABLE.has(prev) || !TRACKABLE.has(next) || prev === next) continue;
    fireAlert(config, service, next).catch(() => {});
  }
}

export function forgetService(serviceId) {
  prevStatusById.delete(serviceId);
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
