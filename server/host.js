// Host machine stats — CPU/memory/disk/uptime — sampled on a background
// timer and cached, same pattern as healthChecker.js: a cheap GET reads
// whatever the last sample was rather than doing work per-request. CPU
// usage in particular needs a delta between two samples of os.cpus(), so
// computing it per-request would mean either blocking on a delay or
// returning garbage from a single instantaneous reading.
//
// Also reports on Mission Control's own process (the `mc` sub-object) —
// added after a real incident where the server quietly degraded over
// ~4 days of uptime with no visible signal until it stopped responding
// altogether. Host-wide CPU/memory/disk say nothing about whether *this
// process* is healthy — a slow leak or a stuck event loop can hide
// underneath perfectly normal host-level numbers. wsClients/sessions come
// from ws.js/auth.js rather than being recomputed here, same
// read-the-one-place-that-owns-it approach as everywhere else in this
// codebase.

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConnectedClientCount } from './ws.js';
import { getActiveSessionCount } from './auth.js';
import { getLastSweepAt } from './healthChecker.js';

const SAMPLE_INTERVAL_MS = 5000;

let lastCpuSample = os.cpus();
let cachedSnapshot = null;
let timer = null;

// Poor-man's event loop lag: a 1s setInterval should fire almost exactly
// 1000ms after the last one. Any excess is time the loop spent blocked on
// something else (synchronous work, a stuck promise chain) instead of
// getting back around to this timer — a generic "is something clogging
// this process" signal, independent of any one specific known failure
// mode. Runs on its own cadence rather than piggybacking on
// SAMPLE_INTERVAL_MS so a blocked loop doesn't also delay detecting itself.
let eventLoopLagMs = 0;
let lastLoopCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  eventLoopLagMs = Math.max(0, now - lastLoopCheck - 1000);
  lastLoopCheck = now;
}, 1000);

function sumCpuTimes(cpus) {
  return cpus.reduce(
    (acc, cpu) => {
      acc.idle += cpu.times.idle;
      acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return acc;
    },
    { idle: 0, total: 0 }
  );
}

function computeCpuPercent() {
  const current = os.cpus();
  const prev = sumCpuTimes(lastCpuSample);
  const curr = sumCpuTimes(current);
  lastCpuSample = current;

  const idleDelta = curr.idle - prev.idle;
  const totalDelta = curr.total - prev.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

// Only reports the drive this app itself lives on — not every drive on the
// host. fs.statfs needs Node 18.15+ (this project already requires
// 18.17+) but is still young enough to fail on some platforms, so this
// degrades to "no disk info" rather than taking the whole sample down.
async function readDiskUsage() {
  try {
    const root = path.parse(process.cwd()).root;
    const stat = await fs.statfs(root);
    const total = stat.blocks * stat.bsize;
    const free = stat.bfree * stat.bsize;
    return { path: root, total, free, used: total - free };
  } catch {
    return null;
  }
}

async function sample() {
  const cpuPercent = computeCpuPercent();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();

  const mem = process.memoryUsage();

  cachedSnapshot = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    uptimeSeconds: os.uptime(),
    cpuPercent,
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
    memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
    disk: await readDiskUsage(),
    // Mission Control's own process — deliberately separate from the
    // host-wide stats above, which say nothing about whether *this*
    // process specifically is healthy. See the file header comment.
    mc: {
      uptimeSeconds: process.uptime(),
      memoryRss: mem.rss,
      wsClients: getConnectedClientCount(),
      sessions: getActiveSessionCount(),
      eventLoopLagMs,
      lastHealthSweepAt: getLastSweepAt(),
    },
    sampledAt: new Date().toISOString(),
  };
}

export function startHostHealthSampler() {
  const tick = async () => {
    await sample();
    timer = setTimeout(tick, SAMPLE_INTERVAL_MS);
  };
  tick();
}

export function stopHostHealthSampler() {
  if (timer) clearTimeout(timer);
}

export function getHostHealthSnapshot() {
  return cachedSnapshot;
}
