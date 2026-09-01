// Creative roadmap, Phase 1 (wave 1a) — the pool of ComfyUI-generated
// wallpapers. The pool is shared (any device can pick any of them); which one
// is *applied* is per-device (localStorage 'mc:wallpaper' → an id here), the
// same split the theme picker already uses.
//
// Same cache + serialized-write-queue shape as profiles.js / codeStore.js,
// its own file + image dir (both gitignored). Capped — the oldest is pruned
// when a new one pushes the count over MAX_WALLPAPERS, image file and all.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { appEvents } from './events.js';
import { writeJsonAtomic } from './jsonStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, 'data', 'wallpapers.json');
export const WALLPAPER_DIR = path.join(__dirname, 'data', 'wallpapers');
const MAX_WALLPAPERS = 24;

let cache = null;
let writeQueue = Promise.resolve();

async function readFromDisk() {
  try {
    return JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  } catch {
    return { wallpapers: [] };
  }
}

async function load() {
  if (!cache) cache = await readFromDisk();
  return cache;
}

async function write() {
  writeQueue = writeQueue.then(() => writeJsonAtomic(DATA_PATH, cache));
  await writeQueue;
}

export async function ensureWallpaperDir() {
  await fs.mkdir(WALLPAPER_DIR, { recursive: true });
  return WALLPAPER_DIR;
}

// ids are server-generated (`wp-` + 10 hex). Validated everywhere one arrives
// from a client as a second guard on the file path built from it.
export function isValidWallpaperId(id) {
  return typeof id === 'string' && /^wp-[a-f0-9]{6,}$/.test(id);
}

// Public view — the on-disk `file` name never leaves the server; the image is
// fetched by id through the route.
function publicMeta({ file, ...rest }) {
  return rest;
}

export async function listWallpapers() {
  const { wallpapers } = await load();
  return wallpapers.map(publicMeta);
}

export async function getWallpaperPath(id) {
  if (!isValidWallpaperId(id)) return null;
  const { wallpapers } = await load();
  const w = wallpapers.find((x) => x.id === id);
  return w ? path.join(WALLPAPER_DIR, w.file) : null;
}

// meta: { themeId, prompt, seed, width, height }. Returns the public meta of
// the stored wallpaper. Emits 'art:wallpapers' so every device's gallery
// refreshes.
export async function addWallpaper(meta, buffer) {
  await ensureWallpaperDir();
  const data = await load();

  const id = `wp-${crypto.randomBytes(5).toString('hex')}`;
  const file = `${id}.png`;
  await fs.writeFile(path.join(WALLPAPER_DIR, file), buffer);

  const record = {
    id,
    themeId: meta.themeId || null,
    prompt: meta.prompt || '',
    seed: meta.seed ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    createdAt: new Date().toISOString(),
    file,
  };
  data.wallpapers.unshift(record);

  while (data.wallpapers.length > MAX_WALLPAPERS) {
    const old = data.wallpapers.pop();
    await fs.unlink(path.join(WALLPAPER_DIR, old.file)).catch(() => {});
  }

  await write();
  appEvents.emit('art:wallpapers', { wallpapers: data.wallpapers.map(publicMeta) });
  return publicMeta(record);
}

export async function deleteWallpaper(id) {
  const data = await load();
  const idx = data.wallpapers.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  const [removed] = data.wallpapers.splice(idx, 1);
  await fs.unlink(path.join(WALLPAPER_DIR, removed.file)).catch(() => {});
  await write();
  appEvents.emit('art:wallpapers', { wallpapers: data.wallpapers.map(publicMeta) });
  return true;
}
