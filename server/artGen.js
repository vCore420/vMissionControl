// Creative roadmap, Phase 1 — the bridge between "I want a picture for <X>"
// and the finished ComfyUI pipeline (comfyImage.js). Wave 1a: theme
// wallpapers. Wave 1b: profile avatars + service icons. Everything here
// composes a prompt, picks dimensions/steps, runs ONE generation, and hands
// back the image buffer + the seed actually used. It owns none of the
// storage — the routes do.

import { loadConfig } from './config.js';
import { generate as comfyGenerate, buildWorkflow } from './comfyImage.js';
import { buildWallpaperPrompt, buildAvatarPrompt, buildServiceIconPrompt } from './artPrompts.js';

// A bad workflow / disabled ComfyUI is a 400 the caller can show verbatim,
// distinct from a 502 when ComfyUI is configured but fell over mid-run.
export class ArtGenError extends Error {}

// One generation at a time across every caller — ComfyUI queues internally,
// but a second concurrent job just holds a connection open for minutes
// behind the first. routes/art.js turns a busy lock into a 409; the
// scheduler (ops roadmap Phase 4b) checks isArtGenerating() and skips.
let generating = false;
export function isArtGenerating() {
  return generating;
}
export async function withArtLock(fn) {
  if (generating) throw new ArtGenError('another image is already generating — give it a moment');
  generating = true;
  try {
    return await fn();
  } finally {
    generating = false;
  }
}

// Checked up front so a route can fail fast instead of opening a WebSocket
// and starting a multi-minute job that was never going to work. Returns the
// validated comfy config block.
export async function assertComfyReady() {
  const { comfy } = await loadConfig();
  if (!comfy?.enabled) {
    throw new ArtGenError('image generation is off — enable it in Settings → ComfyUI');
  }
  try {
    buildWorkflow(comfy, { prompt: 'probe' }); // validates the workflow JSON + node mapping
  } catch (err) {
    throw new ArtGenError(err.message);
  }
  return comfy;
}

// All three targets are deliberately modest on size + steps: a wallpaper
// sits behind a ~72% scrim, an avatar renders at ~64px, an icon smaller
// still, and this often runs on CPU (minutes per image). 768 is the most an
// SD1.5 checkpoint takes without tiling; steps are forced low here rather
// than inherited from the workflow. Raise these if a real GPU shows up.
const WALLPAPER = { w: 768, h: 432, steps: 12 };
const SQUARE = { w: 512, h: 512, steps: 14 };

async function runOne(comfy, prompt, dims, opts) {
  const { images } = await comfyGenerate(
    comfy,
    { prompt, width: dims.w, height: dims.h, steps: dims.steps, count: 1 },
    opts
  );
  if (!images.length) throw new ArtGenError('ComfyUI ran but returned no image');
  return { buffer: images[0].buffer, seed: images[0].seed, prompt };
}

export async function generateWallpaper({ themeId, extraPrompt }, opts = {}) {
  const comfy = await assertComfyReady();
  const out = await runOne(comfy, buildWallpaperPrompt(themeId, extraPrompt), WALLPAPER, opts);
  return { ...out, width: WALLPAPER.w, height: WALLPAPER.h };
}

export async function generateAvatar({ prompt, style }, opts = {}) {
  const comfy = await assertComfyReady();
  return runOne(comfy, buildAvatarPrompt(prompt, style), SQUARE, opts);
}

export async function generateServiceIcon({ name, description, extra }, opts = {}) {
  const comfy = await assertComfyReady();
  return runOne(comfy, buildServiceIconPrompt({ name, description, extra }), SQUARE, opts);
}
