// Creative roadmap, Phase 4 — Jellyfin now-playing + transport. The
// connection lives in config.jellyfin (Settings → Jellyfin); the board's
// 'jellyfin' widget polls /now-playing and POSTs /command. Sending a
// play/pause to a media server on the LAN is low-stakes (nobody loses data),
// so it's just the normal session — activity-logged, no confirm card.

import { Router } from 'express';
import { loadConfig } from '../config.js';
import { pingJellyfin, getNowPlaying, sendCommand, fetchImage, isConfigured } from '../jellyfin.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const jellyfinRouter = Router();

// Test button in Settings — hits the *saved* config.
jellyfinRouter.get('/status', async (req, res) => {
  const config = await loadConfig();
  try {
    res.json({ connected: true, ...(await pingJellyfin(config)) });
  } catch (err) {
    res.status(502).json({ connected: false, error: err.message });
  }
});

// The widget polls this on its own interval. A not-configured or unreachable
// Jellyfin comes back 200 with a flag/message so the tile shows it inline
// rather than the poll just failing.
jellyfinRouter.get('/now-playing', async (req, res) => {
  const config = await loadConfig();
  if (!isConfigured(config)) return res.json({ configured: false, sessions: [] });
  try {
    res.json({ configured: true, sessions: await getNowPlaying(config) });
  } catch (err) {
    res.json({ configured: true, sessions: [], error: err.message });
  }
});

jellyfinRouter.post('/command', async (req, res) => {
  const config = await loadConfig();
  const sessionId = String(req.body?.sessionId || '');
  const command = String(req.body?.command || '');
  if (!sessionId || !command) return res.status(400).json({ error: 'sessionId and command are required' });
  try {
    await sendCommand(config, sessionId, command);
    logActivity('control', `Jellyfin: ${command}`, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Poster proxy — keeps the API key server-side (an <img> can't send a header).
const ITEM_ID_RE = /^[a-f0-9-]{16,40}$/i;
jellyfinRouter.get('/image/:itemId', async (req, res) => {
  if (!ITEM_ID_RE.test(req.params.itemId)) return res.status(400).json({ error: 'bad id' });
  const config = await loadConfig();
  const img = await fetchImage(config, req.params.itemId, String(req.query.tag || ''));
  if (!img) return res.status(404).end();
  res.type(img.contentType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(img.buffer);
});
