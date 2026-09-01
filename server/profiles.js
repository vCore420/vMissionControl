// Per-device profiles (Phase 11) — a display name + an avatar for each
// device that talks to this server, keyed by a client-generated device id
// (localStorage `mc:deviceId`). Host-side and synced, so your name and face
// look the same on every device you open and to everyone else in chat / code.
//
// Same cache + serialized-write-queue shape as codeStore.js / timesheet.js,
// its own file rather than config.json — this is per-device identity that
// changes on a whim, not app configuration. The avatar image, when there is
// one, is a file in data/avatars/ named after the device id; the profile
// record just points at it.
//
// This is not an account system — there's no auth tying a device id to a
// person, same trusted-LAN model as the rest of the app. Clearing browser
// storage gives a device a new id and a fresh profile.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appEvents } from './events.js';
import { writeJsonAtomic } from './jsonStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, 'data', 'profiles.json');
export const AVATAR_DIR = path.join(__dirname, 'data', 'avatars');

const MAX_NAME = 40;

let cache = null;
let writeQueue = Promise.resolve();

async function readFromDisk() {
  try {
    return JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  } catch {
    return { profiles: {} };
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

export async function ensureAvatarDir() {
  await fs.mkdir(AVATAR_DIR, { recursive: true });
  return AVATAR_DIR;
}

// A device id is client-generated (crypto.randomUUID). Only ever used to key
// this store and to name an avatar file, but validate the shape anyway.
export function isValidDeviceId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

function normalise(entry) {
  if (!entry) return { name: '', avatar: null };
  return {
    name: typeof entry.name === 'string' ? entry.name : '',
    avatar: entry.avatar || null,
    updatedAt: entry.updatedAt || null,
  };
}

export async function getProfile(deviceId) {
  const data = await load();
  return normalise(data.profiles[deviceId]);
}

// Everyone's profiles, for rendering avatars beside other people's messages.
export async function allProfiles() {
  const data = await load();
  const out = {};
  for (const [id, entry] of Object.entries(data.profiles)) {
    const n = normalise(entry);
    out[id] = { name: n.name, avatar: n.avatar };
  }
  return out;
}

// patch: { name?, avatar? }. avatar is null (none / cleared), a sprite
// { kind: 'sprite', seed } or an image { kind: 'image', file, updatedAt }.
export async function setProfile(deviceId, patch) {
  const data = await load();
  const current = normalise(data.profiles[deviceId]);
  const next = { ...current };

  if (typeof patch.name === 'string') next.name = patch.name.trim().slice(0, MAX_NAME);

  if (patch.avatar === null) {
    next.avatar = null;
  } else if (patch.avatar && patch.avatar.kind === 'sprite') {
    next.avatar = { kind: 'sprite', seed: String(patch.avatar.seed || deviceId).slice(0, 64) };
  } else if (patch.avatar && patch.avatar.kind === 'image' && typeof patch.avatar.file === 'string') {
    next.avatar = { kind: 'image', file: patch.avatar.file, updatedAt: Date.now() };
  }

  next.updatedAt = new Date().toISOString();
  data.profiles[deviceId] = next;
  await write();
  const profile = { name: next.name, avatar: next.avatar };
  appEvents.emit('profile:updated', { deviceId, profile });
  return profile;
}

// Delete the stored avatar image file for a device (if it has one). Called
// when the avatar is cleared or replaced. Best-effort.
export async function deleteAvatarFile(deviceId) {
  const data = await load();
  const entry = normalise(data.profiles[deviceId]);
  if (entry.avatar?.kind === 'image' && entry.avatar.file) {
    await fs.unlink(path.join(AVATAR_DIR, path.basename(entry.avatar.file))).catch(() => {});
  }
}
