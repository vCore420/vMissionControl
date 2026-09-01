// Creative roadmap, Phase 4 — a thin Jellyfin client for the "now playing"
// widget. Just the transport: global fetch + an AbortController timeout, no
// client library, same instinct as comfy.js / ollama.js. Auth is the API key
// (config.jellyfin.apiKey) sent as the X-Emby-Token header, so it never
// reaches the browser — sanitizeConfig strips it, the image proxy below
// keeps it server-side, and only the settings route ever writes it.

import { normalizeBaseUrl } from './ollama.js';

const TIMEOUT_MS = 6000;
const TICKS_PER_SEC = 10_000_000; // Jellyfin measures time in 100-nanosecond ticks

const COMMANDS = new Set(['PlayPause', 'Pause', 'Unpause', 'Stop', 'NextTrack', 'PreviousTrack']);

function creds(config) {
  const baseUrl = normalizeBaseUrl(config.jellyfin?.baseUrl || '');
  const apiKey = (config.jellyfin?.apiKey || '').trim();
  return { baseUrl, apiKey };
}

export function isConfigured(config) {
  const { baseUrl, apiKey } = creds(config);
  return !!baseUrl && !!apiKey;
}

async function jf(config, path, { method = 'GET', body } = {}) {
  const { baseUrl, apiKey } = creds(config);
  if (!baseUrl) throw new Error('no Jellyfin URL is configured');
  if (!apiKey) throw new Error('no Jellyfin API key is configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'X-Emby-Token': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 401) throw new Error('Jellyfin rejected the API key');
    if (!res.ok) throw new Error(`Jellyfin ${method} ${path.split('?')[0]} returned ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Jellyfin didn't respond within ${TIMEOUT_MS / 1000}s`);
    if (err.cause?.code === 'ECONNREFUSED') throw new Error(`nothing is listening at ${baseUrl}`);
    if (err.cause?.code === 'ENOTFOUND') throw new Error(`can't resolve the Jellyfin host in "${baseUrl}"`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// GET /System/Info — the "Test connection" button.
export async function pingJellyfin(config) {
  const info = await jf(config, '/System/Info');
  return { serverName: info?.ServerName || null, version: info?.Version || null };
}

const sec = (ticks) => (ticks ? Math.round(ticks / TICKS_PER_SEC) : 0);

// GET /Sessions → just the ones actually playing something, normalised for
// the widget.
export async function getNowPlaying(config) {
  const sessions = await jf(config, '/Sessions');
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s.NowPlayingItem)
    .map((s) => {
      const item = s.NowPlayingItem;
      return {
        sessionId: s.Id,
        deviceName: s.DeviceName || s.Client || 'a device',
        userName: s.UserName || null,
        title: item.Name || 'Unknown',
        subtitle: item.SeriesName || item.Album || item.ProductionYear || null,
        type: item.Type || null,
        itemId: item.Id || null,
        imageTag: item.ImageTags?.Primary || null,
        durationSec: sec(item.RunTimeTicks),
        positionSec: sec(s.PlayState?.PositionTicks),
        isPaused: !!s.PlayState?.IsPaused,
      };
    });
}

// POST /Sessions/{id}/Playing/{command}
export async function sendCommand(config, sessionId, command) {
  if (!COMMANDS.has(command)) throw new Error(`unsupported command: ${command}`);
  await jf(config, `/Sessions/${encodeURIComponent(sessionId)}/Playing/${command}`, { method: 'POST' });
}

// GET /Items/{id}/Images/Primary — proxied so the <img> tag doesn't need the
// token. Returns { buffer, contentType } or null (a missing poster is not an
// error worth surfacing).
export async function fetchImage(config, itemId, tag) {
  const { baseUrl, apiKey } = creds(config);
  if (!baseUrl || !apiKey) return null;
  const qs = new URLSearchParams({ maxHeight: '200', quality: '82' });
  if (tag) qs.set('tag', tag);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/Items/${encodeURIComponent(itemId)}/Images/Primary?${qs}`, {
      headers: { 'X-Emby-Token': apiKey },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
