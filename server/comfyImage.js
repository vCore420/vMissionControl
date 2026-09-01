// Turns a ComfyUI API-format workflow into a runnable one for a given prompt.
//
// The workflow is a graph of { "<nodeId>": { class_type, inputs, _meta } }.
// Rather than make the model author that (hopeless) or make you rewrite it
// with %tokens% (fiddly), you paste the workflow unchanged and MC learns
// which node input holds the prompt / seed / size / checkpoint — either
// auto-detected from the graph (autodetectMapping) or set by hand in
// Settings. buildWorkflow() then clones the graph per generation and patches
// just those inputs.
//
// This module owns the whole generation flow: validate + auto-detect the
// mapping, build a per-run workflow, submit it, poll for the result, and
// download the images. codeTools.js#generate_image and (Phase C) the chat
// action call generate(); the transport itself is comfy.js.

import crypto from 'node:crypto';
import { submitPrompt, getHistory, fetchOutput, openProgress } from './comfy.js';

// Node class_types that play each structural role. First match wins.
const SAMPLER_TYPES = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];
const TEXT_ENCODE_TYPES = ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeSDXLRefiner', 'BNK_CLIPTextEncodeAdvanced'];
const CHECKPOINT_TYPES = ['CheckpointLoaderSimple', 'CheckpointLoader', 'unCLIPCheckpointLoader', 'ImageOnlyCheckpointLoader'];
const LATENT_TYPES = ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImageAdvanced'];
const SAVE_TYPES = ['SaveImage', 'SaveImageWebsocket', 'Image Save'];

// The fields the agent tool exposes and buildWorkflow knows how to patch.
// `save` is special — it's just a node id, used to find outputs in /history.
export const MAPPING_FIELDS = ['prompt', 'negative', 'seed', 'steps', 'cfg', 'width', 'height', 'model', 'save'];
const NUMERIC_FIELDS = new Set(['seed', 'steps', 'cfg', 'width', 'height']);

function emptyMapping() {
  return Object.fromEntries(MAPPING_FIELDS.map((f) => [f, null]));
}

// A link input is the tuple [ "<nodeId>", <slot> ]; a literal is anything else.
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

// { ok, error } — or { ok:true, workflow } with the parsed graph. Rejects the
// ComfyUI *UI* export (nodes/links arrays) and anything that isn't the API
// format (a flat map of nodes with class_type + inputs).
export function validateWorkflow(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'paste a workflow first' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not a workflow object' };
  }
  if (Array.isArray(parsed.nodes) || Array.isArray(parsed.links)) {
    return { ok: false, error: 'this is the ComfyUI editor export — use "Save (API Format)" instead (enable Dev Mode in ComfyUI settings)' };
  }
  const nodes = Object.values(parsed);
  if (!nodes.length || !nodes.every((n) => n && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object')) {
    return { ok: false, error: 'not an API-format workflow (each node needs class_type + inputs)' };
  }
  return { ok: true, workflow: parsed };
}

const findByType = (wf, types) => {
  for (const [id, node] of Object.entries(wf)) {
    if (types.includes(node.class_type)) return { id, node };
  }
  return null;
};

// Walk the graph out from the sampler to find where the human-meaningful
// inputs live. Returns a mapping object (fields → { node, key } | null).
export function autodetectMapping(workflow) {
  const wf = typeof workflow === 'string' ? validateWorkflow(workflow).workflow : workflow;
  const map = emptyMapping();
  if (!wf) return map;

  const sampler = findByType(wf, SAMPLER_TYPES);
  if (sampler) {
    const si = sampler.node.inputs;
    if ('seed' in si) map.seed = { node: sampler.id, key: 'seed' };
    else if ('noise_seed' in si) map.seed = { node: sampler.id, key: 'noise_seed' };
    if ('steps' in si) map.steps = { node: sampler.id, key: 'steps' };
    if ('cfg' in si) map.cfg = { node: sampler.id, key: 'cfg' };

    // positive / negative → follow the link to a text-encode node's `text`
    for (const [field, input] of [['prompt', si.positive], ['negative', si.negative]]) {
      if (!isLink(input)) continue;
      const target = wf[input[0]];
      if (target && TEXT_ENCODE_TYPES.includes(target.class_type) && typeof target.inputs?.text === 'string') {
        map[field] = { node: input[0], key: 'text' };
      }
    }

    // latent_image → an EmptyLatentImage's width/height
    if (isLink(si.latent_image)) {
      const latent = wf[si.latent_image[0]];
      if (latent && LATENT_TYPES.includes(latent.class_type)) {
        if ('width' in latent.inputs) map.width = { node: si.latent_image[0], key: 'width' };
        if ('height' in latent.inputs) map.height = { node: si.latent_image[0], key: 'height' };
      }
    }
  }

  // Fallbacks if there was no sampler or its links didn't resolve.
  if (!map.prompt || !map.negative) {
    const encoders = Object.entries(wf).filter(
      ([, n]) => TEXT_ENCODE_TYPES.includes(n.class_type) && typeof n.inputs?.text === 'string'
    );
    if (!map.prompt && encoders[0]) map.prompt = { node: encoders[0][0], key: 'text' };
    if (!map.negative && encoders[1]) map.negative = { node: encoders[1][0], key: 'text' };
  }
  if (!map.width || !map.height) {
    const latent = findByType(wf, LATENT_TYPES);
    if (latent) {
      if (!map.width && 'width' in latent.node.inputs) map.width = { node: latent.id, key: 'width' };
      if (!map.height && 'height' in latent.node.inputs) map.height = { node: latent.id, key: 'height' };
    }
  }

  const ckpt = findByType(wf, CHECKPOINT_TYPES);
  if (ckpt && 'ckpt_name' in ckpt.node.inputs) map.model = { node: ckpt.id, key: 'ckpt_name' };

  const save = findByType(wf, SAVE_TYPES);
  if (save) map.save = { node: save.id, key: save.node.inputs && 'filename_prefix' in save.node.inputs ? 'filename_prefix' : null };

  return map;
}

// Which mapped fields resolved — for the Settings panel to show "detected: …".
export function mappingSummary(map) {
  return MAPPING_FIELDS.filter((f) => map?.[f]?.node).map((f) => `${f} → ${map[f].node}${map[f].key ? `.${map[f].key}` : ''}`);
}

function coerce(field, value) {
  if (!NUMERIC_FIELDS.has(field)) return String(value);
  const n = Number(value);
  return Number.isFinite(n) ? (field === 'cfg' ? n : Math.round(n)) : value;
}

// A fresh seed per call. ComfyUI takes 64-bit seeds; stay inside JS's safe
// integer range (2^48 is plenty of spread and always reproducible).
export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 48);
}

// Clone the workflow and patch in the run's parameters. `params` may set any
// of prompt / negative / seed / steps / cfg / width / height / model; unset
// ones fall back to config.comfy defaults, then to whatever's baked into the
// workflow. Returns { workflow, meta } — meta records the values actually
// used (notably the seed, so a good result can be pinned later).
export function buildWorkflow(comfy, params = {}) {
  const check = validateWorkflow(comfy?.workflow || '');
  if (!check.ok) throw new Error(`workflow is not usable: ${check.error}`);
  const wf = structuredClone(check.workflow);
  const map = comfy.mapping && Object.keys(comfy.mapping).length ? comfy.mapping : autodetectMapping(wf);

  if (!map.prompt?.node) {
    throw new Error("couldn't tell which node holds the prompt — set it in Settings → ComfyUI");
  }

  const prefix = comfy.promptPrefix ? `${comfy.promptPrefix.trim()}, ` : '';
  const suffix = comfy.promptSuffix ? `, ${comfy.promptSuffix.trim()}` : '';

  const resolved = {
    prompt: `${prefix}${String(params.prompt || '').trim()}${suffix}`,
    negative: params.negative ?? comfy.defaultNegative ?? '',
    seed: Number.isFinite(+params.seed) ? Math.round(+params.seed) : randomSeed(),
    steps: params.steps ?? comfy.defaultSteps ?? 20,
    cfg: params.cfg ?? comfy.defaultCfg,
    width: params.width ?? comfy.defaultWidth ?? 512,
    height: params.height ?? comfy.defaultHeight ?? 512,
    model: params.model ?? comfy.model ?? null,
  };

  const meta = {};
  for (const field of ['prompt', 'negative', 'seed', 'steps', 'cfg', 'width', 'height', 'model']) {
    const slot = map[field];
    const value = resolved[field];
    if (value === undefined || value === null || value === '') continue;
    meta[field] = coerce(field, value);
    if (slot?.node && wf[slot.node]?.inputs && slot.key) {
      wf[slot.node].inputs[slot.key] = meta[field];
    }
  }

  return { workflow: wf, meta, saveNode: map.save?.node || null };
}

// ---------- Running a generation ----------

const POLL_MS = 1500;

// When the last generation last did anything (submit / poll / download).
// Phase C's idle-eject timer reads this to decide when to POST /free.
let lastActivityAt = 0;
export function comfyLastActivity() {
  return lastActivityAt;
}

// Generate `count` images for `params` (prompt required; negative/seed/steps/
// cfg/width/height optional, defaulting through buildWorkflow). Each image is
// its own ComfyUI prompt with an incremented seed, so this respects a
// workflow whose latent batch_size is 1 (the common case). Returns
// { images: [{ buffer, filename, seed }], meta }. Honours `signal` (the
// agent's Stop) and a wall-clock budget from comfy.timeoutMs.
export async function generate(comfy, params = {}, { signal, onProgress } = {}) {
  const count = Math.max(1, Math.min(4, Math.round(params.count) || 1));
  const pinnedSeed = Number.isFinite(+params.seed) ? Math.round(+params.seed) : null;
  const clientId = crypto.randomUUID();
  const deadline = Date.now() + (comfy.timeoutMs || 180000);
  const images = [];
  let meta = null;

  // ComfyUI's WebSocket gives real sampler-step progress (x/y); the /history
  // poll below is still the completion signal. `curIndex` lets the WS handler
  // label which image in a batch it's on.
  let curIndex = 0;
  const prog = openProgress(comfy.baseUrl, clientId, (e) => {
    if (e.kind === 'step') onProgress?.({ index: curIndex, count, phase: 'sampling', value: e.value, max: e.max });
  });

  try {
    for (let i = 0; i < count; i++) {
      curIndex = i;
      if (signal?.aborted) throw new Error('cancelled');
      const seed = pinnedSeed != null ? pinnedSeed + i : randomSeed();
      const built = buildWorkflow(comfy, { ...params, seed });
      if (!meta) meta = built.meta;

      lastActivityAt = Date.now();
      const { promptId } = await submitPrompt(comfy.baseUrl, built.workflow, clientId);
      // One "started" note; per-step progress after this comes from the WS
      // (openProgress above), and the poll below is just completion detection.
      onProgress?.({ index: i, count, phase: 'running' });

      let hist = null;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('cancelled');
        await new Promise((r) => setTimeout(r, POLL_MS));
        lastActivityAt = Date.now();
        hist = await getHistory(comfy.baseUrl, promptId, { signal }).catch(() => null);
        if (hist) break;
      }
      if (!hist) throw new Error(`image ${i + 1} timed out after ${Math.round((comfy.timeoutMs || 180000) / 1000)}s`);
      if (hist.status?.status_str === 'error') {
        const msg = (hist.status.messages || [])
          .map((m) => m?.[1]?.exception_message || (m?.[0] === 'execution_error' ? m?.[1]?.exception_type : null))
          .filter(Boolean)[0];
        throw new Error(`ComfyUI failed on image ${i + 1}${msg ? `: ${msg}` : ''}`);
      }

      const outNodes =
        built.saveNode && hist.outputs?.[built.saveNode]
          ? [hist.outputs[built.saveNode]]
          : Object.values(hist.outputs || {});
      const refs = outNodes.flatMap((o) => o?.images || []).filter((im) => im.type === 'output');
      if (!refs.length) throw new Error(`ComfyUI returned no saved image for generation ${i + 1} — does the workflow have a SaveImage node?`);

      for (const ref of refs) {
        const buffer = await fetchOutput(comfy.baseUrl, ref, { signal });
        lastActivityAt = Date.now();
        images.push({ buffer, filename: ref.filename, seed });
      }
      onProgress?.({ index: i + 1, count, phase: 'done' });
    }
  } finally {
    prog.close();
  }

  return { images, meta };
}
