// Host machine stats — CPU/memory/disk/uptime — sampled on a background
// timer and cached, same pattern as healthChecker.js: a cheap GET reads
// whatever the last sample was rather than doing work per-request. CPU
// usage in particular needs a delta between two samples of os.cpus(), so
// computing it per-request would mean either blocking on a delay or
// returning garbage from a single instantaneous reading.

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAMPLE_INTERVAL_MS = 5000;

let lastCpuSample = os.cpus();
let cachedSnapshot = null;
let timer = null;

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
