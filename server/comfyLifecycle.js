// Releases ComfyUI's models from VRAM after an idle period.
//
// Unlike ollamaChat.js there's nothing to *preload* — ComfyUI loads a
// checkpoint when a workflow runs and keeps it resident until memory
// pressure or POST /free. So this is just the eviction half: a slow timer
// that, once nothing has generated for config.comfy.ejectAfterMin minutes
// and the queue is clear, calls freeMemory() so other GPU work has room.
// (Skip it entirely with ejectAfterMin: 0.)

import { loadConfig } from './config.js';
import { comfyLastActivity } from './comfyImage.js';
import { freeMemory, getQueue } from './comfy.js';
import { logActivity } from './activityLog.js';

const CHECK_INTERVAL_MS = 60 * 1000;
let timer = null;
let ejectedAt = 0; // the comfyLastActivity() value we last freed against

async function maybeEject() {
  const { comfy } = await loadConfig();
  if (!comfy?.enabled || !comfy.ejectAfterMin) return;

  const lastAt = comfyLastActivity();
  if (!lastAt || lastAt <= ejectedAt) return; // never generated, or nothing new since the last free
  if (Date.now() - lastAt < comfy.ejectAfterMin * 60 * 1000) return; // not idle long enough

  try {
    const q = await getQueue(comfy.baseUrl).catch(() => ({ running: 0, pending: 0 }));
    if (q.running || q.pending) return; // a generation is in flight — leave it be
    await freeMemory(comfy.baseUrl);
    ejectedAt = lastAt;
    logActivity('code', `ComfyUI models released from VRAM after ${comfy.ejectAfterMin} min idle`);
  } catch {
    // best-effort — an unreachable ComfyUI or a failed /free isn't worth surfacing
  }
}

export function initComfy() {
  timer = setInterval(() => maybeEject().catch(() => {}), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[comfy] idle VRAM-release timer running');
}
