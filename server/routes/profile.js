// Per-device profile routes (Phase 11). The device identifies itself with an
// `X-Mc-Device` header (client-generated id in localStorage `mc:deviceId`),
// added to every request by public/js/api.js. See server/profiles.js.

import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import {
  getProfile, allProfiles, setProfile, deleteAvatarFile, ensureAvatarDir, isValidDeviceId, AVATAR_DIR,
} from '../profiles.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const profileRouter = Router();

function deviceId(req) {
  return req.get('X-Mc-Device') || '';
}

// Routes that act on "my" profile need a valid device id in the header.
// The public reads — the everyone list, and serving an avatar image (loaded
// by an <img> tag, which can't send a custom header) — don't.
profileRouter.use((req, res, next) => {
  if (req.path === '/all' || req.path.startsWith('/avatar/')) return next();
  if (!isValidDeviceId(deviceId(req))) {
    return res.status(400).json({ error: 'missing or malformed device id' });
  }
  next();
});

profileRouter.get('/', async (req, res) => {
  res.json(await getProfile(deviceId(req)));
});

profileRouter.get('/all', async (req, res) => {
  res.json({ profiles: await allProfiles() });
});

profileRouter.put('/', async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (body.avatar === null) patch.avatar = null;
  else if (body.avatar && body.avatar.kind === 'sprite') patch.avatar = { kind: 'sprite', seed: body.avatar.seed };
  // an image avatar is set only through POST /avatar, never here

  const id = deviceId(req);
  // Switching away from an image → drop the file so it doesn't linger.
  if ('avatar' in patch) {
    const current = await getProfile(id);
    if (current.avatar?.kind === 'image' && patch.avatar?.kind !== 'image') await deleteAvatarFile(id);
  }
  res.json(await setProfile(id, patch));
});

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await ensureAvatarDir();
        cb(null, AVATAR_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase().slice(0, 8);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || IMAGE_EXT_RE.test(file.originalname);
    cb(ok ? null : new Error('only image files can be used as an avatar'), ok);
  },
});

profileRouter.post('/avatar', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'an image file is required' });
  const id = deviceId(req);
  await deleteAvatarFile(id); // remove the previous image, if any
  const profile = await setProfile(id, { avatar: { kind: 'image', file: req.file.filename } });
  logActivity('settings', `Set a profile picture`, clientIp(req));
  res.json(profile);
});

// Remove the image and fall back to a sprite seeded from the device id, so
// there's always something to show.
profileRouter.delete('/avatar', async (req, res) => {
  const id = deviceId(req);
  await deleteAvatarFile(id);
  res.json(await setProfile(id, { avatar: { kind: 'sprite', seed: id } }));
});

// Filenames are server-generated (randomUUID + short ext); this only accepts
// that exact shape as a second guard against path traversal.
const SAFE_FILE_RE = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,8}$/;
profileRouter.get('/avatar/:file', async (req, res) => {
  if (!SAFE_FILE_RE.test(req.params.file)) return res.status(400).json({ error: 'invalid filename' });
  const target = path.join(AVATAR_DIR, req.params.file);
  try {
    await fs.access(target);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(target);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
