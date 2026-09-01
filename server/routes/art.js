// Creative roadmap, Phase 1 — generated-image routes. Wave 1a: theme
// wallpapers (Settings → Appearance). Wave 1b: profile avatars (Settings →
// Profile) and service icons (the Add/Edit Service modal).
//
// Generating an image costs real host resources (minutes on CPU), so this
// sits behind the app's normal password gate (requireAuth in index.js) —
// there's no separate switch beyond ComfyUI's own `enabled`, since a
// generation can't start without a workflow configured there anyway. The
// image *reads* are loaded by <img> tags (which can't send the CSRF/device
// headers), so they only lean on that same app-wide auth.

import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { appEvents } from '../events.js';
import { loadConfig, saveConfig } from '../config.js';
import { generateWallpaper, generateAvatar, generateServiceIcon, ArtGenError, withArtLock } from '../artGen.js';
import {
  listWallpapers, addWallpaper, deleteWallpaper, getWallpaperPath, isValidWallpaperId,
} from '../wallpaperStore.js';
import {
  saveServiceIcon, serviceIconPath, deleteServiceIcon, isValidServiceId,
} from '../serviceIcons.js';
import {
  setProfile, deleteAvatarFile, ensureAvatarDir, AVATAR_DIR, isValidDeviceId,
} from '../profiles.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const artRouter = Router();

const deviceId = (req) => req.get('X-Mc-Device') || '';

// One generation at a time across ALL three kinds AND the scheduler — the
// lock lives in artGen.js#withArtLock now; a busy lock throws ArtGenError,
// which the handlers below turn into a 409.

// Shared progress relay: forward ComfyUI's sampler steps to the requesting
// device as 'art:progress' (the client filters on deviceId + kind).
function progressEmitter(dev, kind) {
  const emit = (extra) => appEvents.emit('art:progress', { deviceId: dev, kind, ...extra });
  return {
    onProgress: (p) => { if (p.phase === 'sampling') emit({ phase: 'sampling', value: p.value, max: p.max }); },
    done: () => emit({ phase: 'done' }),
    error: (message) => emit({ phase: 'error', error: message }),
  };
}

// ---------- Wallpapers ----------

artRouter.get('/wallpapers', async (req, res) => {
  res.json({ wallpapers: await listWallpapers() });
});

artRouter.post('/wallpapers', async (req, res) => {
  const themeId = String(req.body?.themeId || '').slice(0, 40);
  const extraPrompt = String(req.body?.extraPrompt || '').slice(0, 400);
  const prog = progressEmitter(deviceId(req), 'wallpaper');

  try {
    const wallpaper = await withArtLock(async () => {
      const result = await generateWallpaper({ themeId, extraPrompt }, { onProgress: prog.onProgress });
      return addWallpaper(
        { themeId, prompt: result.prompt, seed: result.seed, width: result.width, height: result.height },
        result.buffer
      );
    });
    logActivity('settings', `Generated a wallpaper${themeId ? ` (${themeId})` : ''}`, clientIp(req));
    prog.done();
    res.json({ wallpaper });
  } catch (err) {
    prog.error(err.message);
    const busy = err instanceof ArtGenError && /already generating/.test(err.message);
    res.status(busy ? 409 : err instanceof ArtGenError ? 400 : 502).json({ error: err.message });
  }
});

// A generated wallpaper id is immutable and unique per generation, so the
// bytes behind it never change — safe to cache hard.
artRouter.get('/wallpapers/:id/image', async (req, res) => {
  if (!isValidWallpaperId(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const target = await getWallpaperPath(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  sendImage(res, target, 'public, max-age=31536000, immutable');
});

artRouter.delete('/wallpapers/:id', async (req, res) => {
  if (!isValidWallpaperId(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const ok = await deleteWallpaper(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  logActivity('settings', 'Deleted a wallpaper', clientIp(req));
  res.status(204).end();
});

// ---------- Avatars ----------
// The generated image goes through the same storage + profile path as an
// uploaded one (profiles.js): a file in AVATAR_DIR, referenced by
// { kind: 'image', file }. The image reads still go through
// GET /api/profile/avatar/:file, not here.

artRouter.post('/avatar', async (req, res) => {
  const dev = deviceId(req);
  if (!isValidDeviceId(dev)) return res.status(400).json({ error: 'missing or malformed device id' });

  const prompt = String(req.body?.prompt || '').slice(0, 300);
  const style = String(req.body?.style || '').slice(0, 40);
  if (!prompt.trim()) return res.status(400).json({ error: 'describe the avatar you want' });
  const prog = progressEmitter(dev, 'avatar');

  try {
    const profile = await withArtLock(async () => {
      const result = await generateAvatar({ prompt, style }, { onProgress: prog.onProgress });
      await ensureAvatarDir();
      const file = `${crypto.randomUUID()}.png`;
      await fs.writeFile(path.join(AVATAR_DIR, file), result.buffer);
      await deleteAvatarFile(dev); // drop the previous image, if any
      return setProfile(dev, { avatar: { kind: 'image', file } });
    });
    logActivity('settings', 'Generated a profile picture', clientIp(req));
    prog.done();
    res.json(profile);
  } catch (err) {
    prog.error(err.message);
    const busy = err instanceof ArtGenError && /already generating/.test(err.message);
    res.status(busy ? 409 : err instanceof ArtGenError ? 400 : 502).json({ error: err.message });
  }
});

// ---------- Service icons ----------
// One file per service id (serviceIcons.js — no index); the service's own
// `iconImage` field holds a cache-bust timestamp (falsy = none). The
// dashboard renders <img> when it's set, ahead of the emoji / favicon.

artRouter.post('/service-icon/:id', async (req, res) => {
  if (!isValidServiceId(req.params.id)) return res.status(400).json({ error: 'bad service id' });

  const config = await loadConfig();
  const service = config.services.find((s) => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'service not found' });

  const extra = String(req.body?.extraPrompt || '').slice(0, 200);
  const prog = progressEmitter(deviceId(req), 'service-icon');

  try {
    await withArtLock(async () => {
      const result = await generateServiceIcon(
        { name: service.name, description: service.description, extra },
        { onProgress: prog.onProgress }
      );
      await saveServiceIcon(service.id, result.buffer);
      service.iconImage = Date.now();
      await saveConfig(config); // broadcasts 'config' → every device re-renders the card
    });
    logActivity('service', `Generated an icon for "${service.name}"`, clientIp(req));
    prog.done();
    res.json(service);
  } catch (err) {
    prog.error(err.message);
    const busy = err instanceof ArtGenError && /already generating/.test(err.message);
    res.status(busy ? 409 : err instanceof ArtGenError ? 400 : 502).json({ error: err.message });
  }
});

// The bytes change every time the icon is regenerated, so the URL carries a
// ?v=<iconImage> bust and this can still be cached hard against that.
artRouter.get('/service-icon/:id', async (req, res) => {
  const target = serviceIconPath(req.params.id);
  if (!target) return res.status(400).json({ error: 'bad service id' });
  sendImage(res, target, 'public, max-age=31536000, immutable');
});

artRouter.delete('/service-icon/:id', async (req, res) => {
  if (!isValidServiceId(req.params.id)) return res.status(400).json({ error: 'bad service id' });
  const config = await loadConfig();
  const service = config.services.find((s) => s.id === req.params.id);
  await deleteServiceIcon(req.params.id);
  if (service && service.iconImage) {
    delete service.iconImage;
    await saveConfig(config);
    logActivity('service', `Removed the generated icon for "${service.name}"`, clientIp(req));
  }
  res.status(204).end();
});

// ---------- helpers ----------

async function sendImage(res, target, cacheControl) {
  try {
    await fs.access(target);
    res.type('image/png');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', cacheControl);
    res.sendFile(target);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
}
