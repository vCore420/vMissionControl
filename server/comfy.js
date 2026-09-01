// Minimal ComfyUI API client — global fetch + AbortController timeouts, no
// client library, same built-ins-first instinct as ollama.js / docker.js.
// Talks to the ComfyUI HTTP API (default http://127.0.0.1:8188).
//
// This file is just the transport. The workflow-graph manipulation
// (auto-detecting which node holds the prompt, patching in a new prompt/seed/
// size) lives in comfyImage.js; the Code-agent tool and the @cyn chat action
// that call it are in codeTools.js / ollamaTools.js.
//
// ComfyUI's generation flow is asynchronous: POST /prompt queues a workflow
// and returns a prompt_id, then you poll GET /history/<id> until the outputs
// show up, then GET /view fetches each output image. There's no "load this
// model" call — a checkpoint loads when a workflow that references it runs,
// and stays resident until memory pressure or POST /free. That's why the
// lifecycle here is "generate, then eject after an idle period" rather than
// ollama.js's "preload and keep warm".

import { WebSocket } from 'ws';

const PING_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 15000;

export function normalizeBaseUrl(baseUrl) {
  return (baseUrl || '').trim().replace(/\/+$/, '');
}

// One place for the timeout + "turn a raw network error into something a
// person reading the Settings panel can act on" logic. When a caller passes
// its own `signal` (a long generation with its own budget) we defer to it and
// skip the internal timer.
async function comfyFetch(baseUrl, apiPath, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, raw = false } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('no ComfyUI URL is configured');

  let controller;
  let timer;
  let activeSignal = signal;
  if (!activeSignal) {
    controller = new AbortController();
    activeSignal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetch(`${base}${apiPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: activeSignal,
    });
    if (!res.ok) {
      let detail = await res.text().catch(() => '');
      try { detail = JSON.parse(detail).error?.message || JSON.parse(detail).error || detail; } catch { /* raw body */ }
      throw new Error(`ComfyUI ${method} ${apiPath} failed (${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
    }
    return raw ? res : res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        signal
          ? 'the ComfyUI request was cancelled or ran past its timeout'
          : `ComfyUI didn't respond within ${Math.round(timeoutMs / 1000)}s — is it running at ${base}?`
      );
    }
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Nothing is listening at ${base} — is ComfyUI running?`);
    }
    if (err.cause?.code === 'ENOTFOUND' || err.cause?.code === 'EAI_AGAIN') {
      throw new Error(`Can't resolve the ComfyUI host in "${base}" — check the URL.`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// GET /system_stats — "is it there", plus device/VRAM info the Settings panel
// shows so you know whether ComfyUI found your GPU.
export async function pingComfy(baseUrl) {
  const data = await comfyFetch(baseUrl, '/system_stats', { timeoutMs: PING_TIMEOUT_MS });
  const dev = data.devices?.[0] || {};
  return {
    version: data.system?.comfyui_version ?? null,
    device: dev.name ?? null,
    deviceType: dev.type ?? null,          // 'cuda' | 'cpu' | ...
    vramTotalMB: dev.vram_total ? Math.round(dev.vram_total / 1024 ** 2) : null,
    vramFreeMB: dev.vram_free ? Math.round(dev.vram_free / 1024 ** 2) : null,
  };
}

// The installed checkpoints, for the Settings model dropdown. Pulled from the
// CheckpointLoaderSimple node's own enum of valid values.
export async function listCheckpoints(baseUrl) {
  const data = await comfyFetch(baseUrl, '/object_info/CheckpointLoaderSimple', { timeoutMs: PING_TIMEOUT_MS });
  const values = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(values) ? values : [];
}

// GET /queue — running + pending prompt ids. Used by the status endpoint to
// tell "idle" from "busy" (and, in Phase C, whether it's safe to POST /free).
export async function getQueue(baseUrl) {
  const data = await comfyFetch(baseUrl, '/queue', { timeoutMs: PING_TIMEOUT_MS });
  return {
    running: (data.queue_running || []).length,
    pending: (data.queue_pending || []).length,
  };
}

// POST /prompt — queue a workflow (API-format graph). `clientId` is only used
// to route the optional WebSocket progress feed; polling /history works
// without it. Returns { promptId, nodeErrors }.
export async function submitPrompt(baseUrl, workflow, clientId) {
  const body = { prompt: workflow };
  if (clientId) body.client_id = clientId;
  const data = await comfyFetch(baseUrl, '/prompt', { method: 'POST', body, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (data.node_errors && Object.keys(data.node_errors).length) {
    const first = Object.values(data.node_errors)[0];
    throw new Error(`ComfyUI rejected the workflow: ${first?.errors?.[0]?.message || JSON.stringify(first).slice(0, 200)}`);
  }
  return { promptId: data.prompt_id, nodeErrors: data.node_errors || null };
}

// GET /history/<promptId> — null until the prompt finishes, then
// { status, outputs: { <nodeId>: { images: [{ filename, subfolder, type }] } } }.
export async function getHistory(baseUrl, promptId, { signal } = {}) {
  const data = await comfyFetch(baseUrl, `/history/${encodeURIComponent(promptId)}`, { signal, timeoutMs: PING_TIMEOUT_MS });
  return data[promptId] || null;
}

// GET /view — the actual image bytes for one output. Returns a Buffer.
export async function fetchOutput(baseUrl, { filename, subfolder = '', type = 'output' }, { signal } = {}) {
  const qs = new URLSearchParams({ filename, subfolder, type }).toString();
  const res = await comfyFetch(baseUrl, `/view?${qs}`, { signal, timeoutMs: DEFAULT_TIMEOUT_MS, raw: true });
  return Buffer.from(await res.arrayBuffer());
}

// POST /free — release checkpoints/VAE/CLIP from VRAM. Called by the idle
// eject timer. Best-effort, and the response has no useful body, so `raw`
// (don't try to JSON-parse an empty 200).
export async function freeMemory(baseUrl) {
  await comfyFetch(baseUrl, '/free', {
    method: 'POST',
    body: { unload_models: true, free_memory: true },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    raw: true,
  });
}

// POST /interrupt — stop the running generation (the Stop button). Also an
// empty-body response.
export async function interrupt(baseUrl) {
  await comfyFetch(baseUrl, '/interrupt', { method: 'POST', timeoutMs: PING_TIMEOUT_MS, raw: true });
}

// Open ComfyUI's progress WebSocket for one client id and forward the useful
// events. ComfyUI routes `progress` (sampler step x/y) and `execution_error`
// to whichever client id submitted the prompt, so `clientId` here must match
// the one passed to submitPrompt. Best-effort: if the socket won't open, the
// caller just falls back to its /history poll for completion. Returns
// { close() }.
export function openProgress(baseUrl, clientId, onEvent) {
  const wsUrl = normalizeBaseUrl(baseUrl).replace(/^http/i, 'ws') + `/ws?clientId=${encodeURIComponent(clientId)}`;
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch {
    return { close() {} };
  }
  socket.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'progress' && m.data) {
      onEvent({ kind: 'step', value: m.data.value, max: m.data.max });
    } else if (m.type === 'execution_error' && m.data) {
      onEvent({ kind: 'error', detail: m.data.exception_message || m.data.exception_type });
    }
  });
  socket.on('error', () => {});
  return {
    close() {
      try { socket.close(); } catch { /* already gone */ }
    },
  };
}
