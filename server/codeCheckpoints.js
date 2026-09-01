// Per-turn file checkpoints for the Code agent (Code parity roadmap 2c).
//
// Before the first write of a turn touches disk, the pre-write state of every
// path that turn's write tools will change is copied into
// server/data/code-checkpoints/<sessionId>/<messageId>/. A "↩ Revert this
// turn" button on that assistant message then restores every captured path —
// rolling back an edit, deleting a file the turn created, or recreating one it
// removed.
//
// What is NOT captured: anything a run_command side-effected (the tool can
// touch the whole host — there's no knowing what changed). The checkpoint just
// records that a command ran, so the revert UI can say those effects stand.
//
// No git — a plain file copy. Kept: the last CHECKPOINT_KEEP turns per session
// (older dirs pruned on each finalize); a session's whole tree goes when the
// session is deleted (dropSessionCheckpoints, called from routes/code.js).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeResolve } from './codeWorkspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'data', 'code-checkpoints');
const CHECKPOINT_KEEP = 10;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // a bigger file is recorded but not snapshotted (unrevertable)

// Manifests under construction this process, keyed `${sessionId}::${messageId}`.
// Populated by captureBeforeWrite/noteCommandRun during a turn, flushed to
// meta.json by finalizeCheckpoint at turn end.
const building = new Map();

const keyFor = (s, m) => `${s}::${m}`;
const seg = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
const turnDir = (s, m) => path.join(ROOT, seg(s), seg(m));
const normRel = (p) => String(p || '').trim().replace(/^[/\\]+/, '').replace(/\\/g, '/');

function manifest(sessionId, messageId) {
  const k = keyFor(sessionId, messageId);
  let m = building.get(k);
  if (!m) {
    m = { files: [], commandsRun: false, seen: new Set() };
    building.set(k, m);
  }
  return m;
}

// Before a write tool executes. Idempotent per (turn, path): the FIRST capture
// of a path wins — that's its pre-turn state. Never throws; a capture failure
// just leaves that path out of the manifest (so it won't be revertable).
export async function captureBeforeWrite(config, sessionId, messageId, relPath) {
  const rel = normRel(relPath);
  if (!rel) return;
  const m = manifest(sessionId, messageId);
  if (m.seen.has(rel)) return;
  m.seen.add(rel);

  let abs;
  try {
    abs = safeResolve(config, rel);
  } catch {
    return;
  }

  const entry = { rel };
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      entry.existed = true;
      entry.kind = 'dir';
    } else if (st.size > MAX_FILE_BYTES) {
      entry.existed = true;
      entry.kind = 'file';
      entry.tooBig = true;
    } else {
      const blobsDir = path.join(turnDir(sessionId, messageId), 'blobs');
      await fs.mkdir(blobsDir, { recursive: true });
      const blob = String(m.files.length);
      await fs.copyFile(abs, path.join(blobsDir, blob));
      entry.existed = true;
      entry.kind = 'file';
      entry.blob = blob;
    }
  } catch {
    entry.existed = false; // nothing there → revert removes whatever the turn creates
  }
  m.files.push(entry);
}

// Mark that this turn ran a (foreground) shell command — surfaced next to the
// revert button as "commands this turn ran are not undone".
export function noteCommandRun(sessionId, messageId) {
  manifest(sessionId, messageId).commandsRun = true;
}

// Turn end. Writes meta.json and prunes old turns iff the turn actually
// captured a file; returns the summary for the message's `checkpoint` flag, or
// null when there's nothing to revert (a command-only or read-only turn).
export async function finalizeCheckpoint(sessionId, messageId) {
  const k = keyFor(sessionId, messageId);
  const m = building.get(k);
  building.delete(k);
  if (!m || !m.files.length) return null;

  const meta = {
    sessionId,
    messageId,
    createdAt: new Date().toISOString(),
    commandsRun: m.commandsRun,
    files: m.files.map(({ rel, existed, kind, blob, tooBig }) => ({ rel, existed, kind, blob, tooBig })),
  };
  try {
    await fs.mkdir(turnDir(sessionId, messageId), { recursive: true });
    await fs.writeFile(path.join(turnDir(sessionId, messageId), 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error('[code] checkpoint write failed:', err.message);
    return null;
  }
  // Awaited (not fire-and-forget) so it's deterministic — turns never overlap
  // (the session busy-guard), so there's no prune racing another prune.
  await pruneSession(sessionId).catch(() => {});

  return {
    files: m.files.length,
    revertableFiles: m.files.filter((f) => !f.tooBig).length,
    commandsRun: m.commandsRun,
  };
}

// Roll every captured path back to its pre-turn state. Returns
// { restored, removed, skipped, errors } (arrays of rel paths) or { error }.
export async function revertCheckpoint(config, sessionId, messageId) {
  const dir = turnDir(sessionId, messageId);
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf-8'));
  } catch {
    return { error: 'this checkpoint is no longer available' };
  }

  const out = { restored: [], removed: [], skipped: [], errors: [] };
  for (const f of meta.files || []) {
    let abs;
    try {
      abs = safeResolve(config, f.rel);
    } catch {
      out.errors.push(f.rel);
      continue;
    }
    try {
      if (!f.existed) {
        await fs.rm(abs, { recursive: true, force: true });
        out.removed.push(f.rel);
      } else if (f.kind === 'dir') {
        await fs.mkdir(abs, { recursive: true });
        out.restored.push(f.rel);
      } else if (f.tooBig || !f.blob) {
        out.skipped.push(f.rel);
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.copyFile(path.join(dir, 'blobs', f.blob), abs);
        out.restored.push(f.rel);
      }
    } catch {
      out.errors.push(f.rel);
    }
  }
  return out;
}

export async function dropSessionCheckpoints(sessionId) {
  await fs.rm(path.join(ROOT, seg(sessionId)), { recursive: true, force: true }).catch(() => {});
}

// Keep only the newest CHECKPOINT_KEEP turn dirs for a session.
async function pruneSession(sessionId) {
  const base = path.join(ROOT, seg(sessionId));
  let dirs;
  try {
    dirs = await fs.readdir(base);
  } catch {
    return;
  }
  const stamped = [];
  for (const d of dirs) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(base, d, 'meta.json'), 'utf-8'));
      stamped.push({ d, t: meta.createdAt || '' });
    } catch {
      stamped.push({ d, t: '' });
    }
  }
  stamped.sort((a, b) => (a.t < b.t ? 1 : -1));
  for (const { d } of stamped.slice(CHECKPOINT_KEEP)) {
    await fs.rm(path.join(base, d), { recursive: true, force: true }).catch(() => {});
  }
}
