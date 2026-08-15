// Polls each HTTP-checkable service on an interval and keeps an in-memory
// status cache. The frontend polls GET /api/status cheaply instead of
// triggering a network request per page load, and also gets pushed fresh
// status over the WebSocket the moment a sweep finishes — the poll stays in
// place as a fallback in case a client's socket is down. Alongside the
// current status, a capped per-service history ring buffer is kept so the
// frontend can show an uptime sparkline without needing a real time-series
// database.

import { appEvents } from './events.js';

const statusCache = new Map();
const historyCache = new Map(); // serviceId -> Array<{status: 'online'|'offline', t: number}>
let timer = null;

const HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours of samples is plenty for a sparkline
const HISTORY_MAX_ENTRIES = 2000; // safety cap regardless of check interval
const SPARKLINE_SAMPLES = 30;

function recordHistory(serviceId, status) {
  if (status !== 'online' && status !== 'offline') return; // skip unmonitored/checking noise
  let history = historyCache.get(serviceId);
  if (!history) {
    history = [];
    historyCache.set(serviceId, history);
  }
  history.push({ status, t: Date.now() });

  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  while (history.length && (history[0].t < cutoff || history.length > HISTORY_MAX_ENTRIES)) {
    history.shift();
  }
}

function markUnmonitored(service) {
  statusCache.set(service.id, {
    id: service.id,
    status: 'unmonitored',
    latencyMs: null,
    lastChecked: null,
    error: null,
  });
}

async function checkOne(service, timeoutMs) {
  if (!service.healthCheck) {
    markUnmonitored(service);
    return;
  }

  const url = service.url.replace(/\/+$/, '') + (service.healthCheckPath || '/');
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const latencyMs = Math.round(performance.now() - started);
    const status = res.ok || res.status < 500 ? 'online' : 'offline';
    statusCache.set(service.id, {
      id: service.id,
      status,
      httpStatus: res.status,
      latencyMs,
      lastChecked: new Date().toISOString(),
      error: null,
    });
    recordHistory(service.id, status);
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    statusCache.set(service.id, {
      id: service.id,
      status: 'offline',
      httpStatus: null,
      latencyMs,
      lastChecked: new Date().toISOString(),
      error: err.name === 'AbortError' ? 'timeout' : err.message,
    });
    recordHistory(service.id, 'offline');
  } finally {
    clearTimeout(timeout);
  }
}

async function runSweep(getConfig) {
  const config = await getConfig();
  const timeoutMs = config.settings.healthCheckTimeoutMs ?? 3000;
  await Promise.allSettled(config.services.map((s) => checkOne(s, timeoutMs)));
  appEvents.emit('status', getStatusSnapshot());
}

export function startHealthChecker(getConfig) {
  const tick = async () => {
    const config = await getConfig();
    await runSweep(getConfig);
    const intervalMs = config.settings.healthCheckIntervalMs ?? 15000;
    timer = setTimeout(tick, intervalMs);
  };
  tick();
}

export function stopHealthChecker() {
  if (timer) clearTimeout(timer);
}

export function getStatusSnapshot() {
  return Array.from(statusCache.values()).map((entry) => {
    const history = historyCache.get(entry.id) || [];
    const relevant = history.filter((h) => h.status === 'online' || h.status === 'offline');
    const uptimePercent = relevant.length
      ? Math.round((relevant.filter((h) => h.status === 'online').length / relevant.length) * 100)
      : null;
    return {
      ...entry,
      uptimePercent,
      history: history.slice(-SPARKLINE_SAMPLES).map((h) => h.status),
    };
  });
}

// Called after config edits so a newly added/edited service gets checked
// immediately instead of waiting for the next full sweep.
export async function checkNow(getConfig) {
  await runSweep(getConfig);
}

// Rechecks a single service on demand (e.g. a "check now" button) without
// waiting for or disturbing the regular sweep interval.
export async function checkOneService(getConfig, serviceId) {
  const config = await getConfig();
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return null;
  const timeoutMs = config.settings.healthCheckTimeoutMs ?? 3000;
  await checkOne(service, timeoutMs);
  const snapshot = getStatusSnapshot();
  appEvents.emit('status', snapshot);
  return snapshot.find((s) => s.id === serviceId) ?? null;
}

// Called when a service is deleted so its cached status/history don't leak
// forever in memory.
export function forgetService(serviceId) {
  statusCache.delete(serviceId);
  historyCache.delete(serviceId);
}
