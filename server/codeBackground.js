// Background shell commands for the Code agent (Code parity roadmap 2a).
//
// run_command's normal path (codeExec.js) is synchronous — the turn waits
// for the command to finish. That can't start a dev server and then test
// against it. This module spawns a command that keeps running past the turn,
// buffers its output in a ring, and lets a later turn check on it or stop
// it (the check_command / stop_command tools) — and lets the human see and
// kill it from the Code view's "running" strip.
//
// Same trust model as codeExec.js: runs as the Mission Control user, gated
// by config.code.allowCommands + the session's approval mode. A background
// command is killed on explicit stop, when its session is deleted, on a
// 2-hour age cap, and on server shutdown.

import { spawn, exec } from 'node:child_process';
import { resolveWorkspacePath, safeResolve } from './codeWorkspace.js';
import { appEvents } from './events.js';

const MAX_LINES = 400;          // ring-buffer depth per command
const LINE_CAP = 2000;          // chars per line
const MAX_PER_SESSION = 4;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const REAP_EXITED_AFTER_MS = 10 * 60 * 1000;

const procs = new Map(); // bgId -> entry

let seq = 0;
const newId = () => `bg-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const isWin = process.platform === 'win32';

function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  try {
    if (isWin) {
      exec(`taskkill /pid ${child.pid} /T /F`, () => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
    }
  } catch {
    /* already gone */
  }
}

function ingest(entry, stream, chunk) {
  const text = chunk.toString('utf-8');
  const lines = text.split('\n');
  // A chunk rarely ends on a newline; keep the trailing partial attached to
  // the next chunk of the same stream.
  const partialKey = stream === 'err' ? '_errPartial' : '_outPartial';
  lines[0] = (entry[partialKey] || '') + lines[0];
  entry[partialKey] = lines.pop() ?? '';
  for (const line of lines) entry.out.push({ s: stream, t: line.slice(0, LINE_CAP) });
  if (entry.out.length > MAX_LINES) entry.out.splice(0, entry.out.length - MAX_LINES);
}

export function hasBackground(sessionId) {
  for (const e of procs.values()) if (e.sessionId === sessionId) return true;
  return false;
}

// Returns { bgId } or { error }. Never throws.
export async function startBackground(config, { sessionId, command, cwdRel }) {
  const liveForSession = [...procs.values()].filter((p) => p.sessionId === sessionId && !p.exited).length;
  if (liveForSession >= MAX_PER_SESSION) {
    return { error: `this session already has ${MAX_PER_SESSION} background commands running — stop one before starting another` };
  }
  let cwd;
  try {
    cwd = cwdRel ? safeResolve(config, cwdRel) : resolveWorkspacePath(config);
  } catch (err) {
    return { error: err.message };
  }

  const bgId = newId();
  let child;
  try {
    child = spawn(command, { cwd, shell: true, windowsHide: true, detached: !isWin });
  } catch (err) {
    return { error: `couldn't start: ${err.message}` };
  }

  const entry = {
    bgId, sessionId, command, cwdRel: cwdRel || '',
    child, out: [], startedAt: Date.now(), endedAt: null,
    exited: false, exitCode: null, signal: null,
  };
  procs.set(bgId, entry);

  child.stdout?.on('data', (c) => ingest(entry, 'out', c));
  child.stderr?.on('data', (c) => ingest(entry, 'err', c));
  child.on('error', (err) => {
    entry.out.push({ s: 'err', t: `failed to start: ${err.message}` });
    finish(entry, -1, null);
  });
  child.on('exit', (code, sig) => finish(entry, code, sig));

  appEvents.emit('code:background', { sessionId });
  return { bgId };
}

function finish(entry, code, sig) {
  if (entry.exited) return;
  entry.exited = true;
  entry.exitCode = code;
  entry.signal = sig;
  entry.endedAt = Date.now();
  // flush any trailing partial line
  for (const k of ['_outPartial', '_errPartial']) {
    if (entry[k]) {
      entry.out.push({ s: k === '_errPartial' ? 'err' : 'out', t: entry[k].slice(0, LINE_CAP) });
      entry[k] = '';
    }
  }
  appEvents.emit('code:background', { sessionId: entry.sessionId });
}

function renderOut(entry, cap = 8000) {
  return entry.out
    .map((l) => (l.s === 'err' ? `[stderr] ${l.t}` : l.t))
    .join('\n')
    .slice(-cap);
}

// check_command tool
export function checkBackground(bgId) {
  const e = procs.get(bgId);
  if (!e) return { error: `no background command "${bgId}" — it may have been reaped` };
  return {
    bgId: e.bgId,
    command: e.command,
    running: !e.exited,
    exitCode: e.exited ? e.exitCode : null,
    ranForSeconds: Math.round(((e.endedAt || Date.now()) - e.startedAt) / 1000),
    output: renderOut(e) || '(no output yet)',
  };
}

// stop_command tool + the human's Stop button
export function stopBackground(bgId) {
  const e = procs.get(bgId);
  if (!e) return { error: `no background command "${bgId}"` };
  if (e.exited) return { bgId, alreadyStopped: true, exitCode: e.exitCode };
  killTree(e.child);
  return { bgId, stopping: true, command: e.command };
}

// The Code view's "running" strip.
export function listBackground(sessionId) {
  return [...procs.values()]
    .filter((p) => p.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((e) => ({
      bgId: e.bgId,
      command: e.command,
      cwd: e.cwdRel || null,
      running: !e.exited,
      exitCode: e.exited ? e.exitCode : null,
      startedAt: new Date(e.startedAt).toISOString(),
      tail: e.out.slice(-30).map((l) => (l.s === 'err' ? `⚠ ${l.t}` : l.t)).join('\n'),
    }));
}

export function stopSessionBackground(sessionId) {
  for (const e of procs.values()) {
    if (e.sessionId === sessionId) {
      killTree(e.child);
      procs.delete(e.bgId);
    }
  }
}

export function stopAllBackground() {
  for (const e of procs.values()) killTree(e.child);
  procs.clear();
}

let reaper = null;
export function initBackgroundReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of procs) {
      if (!e.exited && now - e.startedAt > MAX_AGE_MS) {
        e.out.push({ s: 'err', t: `stopped by Mission Control — background commands are capped at ${MAX_AGE_MS / 3600000}h` });
        killTree(e.child);
      }
      if (e.exited && e.endedAt && now - e.endedAt > REAP_EXITED_AFTER_MS) procs.delete(id);
    }
  }, 60000);
  if (reaper.unref) reaper.unref();
}

export function stopBackgroundReaper() {
  if (reaper) clearInterval(reaper);
  reaper = null;
}
