// Image attachments on a Code message (Code parity roadmap 4a/4b).
//
// The composer sends images as data URLs in the POST body's `images` array.
// parseImageAttachments validates and decodes them (image types only, per-
// image and count caps). The decoded bytes go two ways:
//   - to codeVision.describeImages, which is the model's only view of them
//   - to disk under server/data/code-images/<session>/, so the transcript can
//     still show the picture after the turn (saveImages) — cleaned when the
//     session is deleted (dropSessionImages)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'data', 'code-images');

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // per image, decoded (keep 4×this under index.js's /api/code body limit)
const MAX_PER_SESSION = 40;              // prune the oldest files past this
const TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const seg = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
const sessionDir = (sessionId) => path.join(ROOT, seg(sessionId));

// raw: [{ name, dataUrl }] from the POST body.
// → { stored: [{ name, bytes, type }], forVision: [{ name, b64, type }] }
export function parseImageAttachments(raw) {
  if (!Array.isArray(raw) || !raw.length) return { stored: [], forVision: [] };

  const stored = [];
  const forVision = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    const name = String(item?.name || 'image').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'image';
    const dataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl : '';
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) {
      stored.push({ name, bytes: 0, type: null, error: 'not a recognised image' });
      continue;
    }
    const type = m[1].toLowerCase();
    if (!TYPE_EXT[type]) {
      stored.push({ name, bytes: 0, type, error: 'unsupported image type' });
      continue;
    }
    const b64 = m[2].replace(/\s+/g, '');
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      stored.push({ name, bytes, type, error: `too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` });
      continue;
    }
    stored.push({ name, bytes, type });
    forVision.push({ name, b64, type });
  }
  return { stored, forVision };
}

// Write the decoded images to disk so the transcript can render them. Returns
// the stored metadata with a `file` field added for the ones that saved
// (`<messageId>-<i>.<ext>`), which routes/code.js patches onto the message.
export async function saveImages(sessionId, messageId, forVision) {
  if (!Array.isArray(forVision) || !forVision.length) return [];
  const dir = sessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const out = [];
  for (let i = 0; i < forVision.length; i++) {
    const img = forVision[i];
    const ext = TYPE_EXT[img.type] || 'png';
    const file = `${seg(messageId)}-${i}.${ext}`;
    try {
      await fs.writeFile(path.join(dir, file), Buffer.from(img.b64, 'base64'));
      out.push({ name: img.name, type: img.type, bytes: Math.floor((img.b64.length * 3) / 4), file });
    } catch {
      out.push({ name: img.name, type: img.type, bytes: 0 });
    }
  }
  pruneSession(sessionId).catch(() => {});
  return out;
}

// Absolute path of one stored image, or null if the name isn't a plain
// basename (no traversal) — used by the serving route.
export function imageFilePath(sessionId, file) {
  const base = String(file || '');
  if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) return null;
  return path.join(sessionDir(sessionId), base);
}

export async function dropSessionImages(sessionId) {
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

async function pruneSession(sessionId) {
  const dir = sessionDir(sessionId);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  if (names.length <= MAX_PER_SESSION) return;
  const withTime = [];
  for (const n of names) {
    try {
      withTime.push({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs });
    } catch {
      withTime.push({ n, t: 0 });
    }
  }
  withTime.sort((a, b) => b.t - a.t);
  for (const { n } of withTime.slice(MAX_PER_SESSION)) {
    await fs.rm(path.join(dir, n), { force: true }).catch(() => {});
  }
}
