import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { loadConfig, saveConfig } from '../config.js';
import { getMessages, addMessage, deleteMessage, deleteChannelMessages, ensureUploadDir, UPLOAD_DIR } from '../chat.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const chatRouter = Router();

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `channel-${Date.now()}`
  );
}

// ---------- Channels (structural, so they live in config.json — every
// create/delete goes through saveConfig, which already broadcasts the
// updated config to every connected device, same as services/groups) ----------

chatRouter.get('/channels', async (req, res) => {
  const config = await loadConfig();
  res.json({ channels: config.chatChannels });
});

chatRouter.post('/channels', async (req, res) => {
  const config = await loadConfig();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  let id = slugify(name);
  if (config.chatChannels.some((c) => c.id === id)) id = `${id}-${Date.now()}`;

  const channel = { id, name };
  config.chatChannels.push(channel);
  await saveConfig(config);
  logActivity('chat', `Created channel "${channel.name}"`, clientIp(req));
  res.status(201).json(channel);
});

chatRouter.put('/channels/reorder', async (req, res) => {
  const config = await loadConfig();
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return res.status(400).json({ error: 'ids must be an array of channel ids' });
  }
  const byId = new Map(config.chatChannels.map((c) => [c.id, c]));
  if (!ids.every((id) => byId.has(id))) {
    return res.status(400).json({ error: 'unknown channel id in reorder list' });
  }

  const idSet = new Set(ids);
  let cursor = 0;
  config.chatChannels = config.chatChannels.map((c) => (idSet.has(c.id) ? byId.get(ids[cursor++]) : c));

  await saveConfig(config);
  res.json({ ok: true });
});

// Rename a channel and/or set its per-channel assistant persona. Registered
// after /channels/reorder so that word isn't captured as an :id. Persona
// fields are all optional — an empty string clears that one back to the
// global default (Settings -> Ollama); the trigger word stays global.
chatRouter.put('/channels/:id', async (req, res) => {
  const config = await loadConfig();
  const channel = config.chatChannels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });

  const body = req.body || {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return res.status(400).json({ error: 'a channel name cannot be empty' });
    channel.name = name.slice(0, 40);
  }
  if (body.ollama && typeof body.ollama === 'object') {
    const o = body.ollama;
    const persona = {};
    if (typeof o.botName === 'string' && o.botName.trim()) persona.botName = o.botName.trim().slice(0, 40);
    if (typeof o.botEmoji === 'string' && o.botEmoji.trim()) persona.botEmoji = o.botEmoji.trim().slice(0, 8);
    if (typeof o.systemPrompt === 'string' && o.systemPrompt.trim()) persona.systemPrompt = o.systemPrompt.slice(0, 8000);
    if (Object.keys(persona).length) channel.ollama = persona;
    else delete channel.ollama;
  }

  await saveConfig(config);
  logActivity('chat', `Updated channel "${channel.name}"`, clientIp(req));
  res.json(channel);
});

chatRouter.delete('/channels/:id', async (req, res) => {
  const config = await loadConfig();
  if (config.chatChannels.length <= 1) {
    return res.status(400).json({ error: 'at least one channel must exist' });
  }
  const idx = config.chatChannels.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'channel not found' });

  const deletedName = config.chatChannels[idx].name;
  config.chatChannels.splice(idx, 1);
  await saveConfig(config);
  await deleteChannelMessages(req.params.id);
  logActivity('chat', `Deleted channel "${deletedName}"`, clientIp(req));
  res.status(204).end();
});

// ---------- Messages (ephemeral — see chat.js for why) ----------

chatRouter.get('/channels/:id/messages', (req, res) => {
  res.json({ messages: getMessages(req.params.id) });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await ensureUploadDir();
        cb(null, UPLOAD_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

chatRouter.post('/channels/:id/messages', upload.single('file'), async (req, res) => {
  const config = await loadConfig();
  if (!config.chatChannels.some((c) => c.id === req.params.id)) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    return res.status(404).json({ error: 'channel not found' });
  }

  const text = (req.body.text || '').trim();
  if (!text && !req.file) {
    return res.status(400).json({ error: 'a message needs text or an attachment' });
  }
  if (text.length > 5000) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'text is too long (max 5000 characters)' });
  }

  const author = (req.body.author || 'Anonymous').trim().slice(0, 40);
  const deviceId = (req.get('X-Mc-Device') || req.body.deviceId || '').slice(0, 64) || undefined;
  const attachment = req.file
    ? {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      }
    : null;

  const message = addMessage(req.params.id, { author, text, deviceId, attachment });
  res.status(201).json(message);
});

chatRouter.delete('/messages/:channelId/:messageId', async (req, res) => {
  const removed = await deleteMessage(req.params.channelId, req.params.messageId);
  if (!removed) return res.status(404).json({ error: 'message not found' });
  res.status(204).end();
});

// Filenames here are always server-generated (crypto.randomUUID() + a short
// extension in the upload handler above), never taken verbatim from a
// client path, but this endpoint still only accepts that exact shape as a
// second line of defense against path traversal.
const SAFE_FILENAME_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]{1,10})?$/;

chatRouter.get('/attachments/:filename', async (req, res) => {
  if (!SAFE_FILENAME_RE.test(req.params.filename)) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  const target = path.join(UPLOAD_DIR, req.params.filename);
  try {
    await fs.access(target);
    res.sendFile(target);
  } catch {
    res.status(404).json({ error: 'attachment not found' });
  }
});
