// Minimal Ollama REST client — node:http/https plus AbortController timeouts,
// no client library, same built-ins-over-dependencies instinct as docker.js
// (which also talks its API straight over node:http) and auth.js. Talks to the
// Ollama HTTP API (default http://localhost:11434).
//
// Why node:http and not fetch: Ollama holds the HTTP response open — no status
// line, no headers — for the whole prompt-eval + first-token wait on a chat
// call. On a slow box that wait runs past undici's 300 s headersTimeout (not
// configurable without importing `undici`, which isn't resolvable as a bare
// specifier here), and the caller's own longer AbortController never gets a
// look in — the turn just dies with an opaque "fetch failed". node:http has no
// such timer, so the only clock on an Ollama call is the one the caller sets.
//
// The chat-message routing that uses chat() lives in ollamaChat.js; this
// file is just the transport.

import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 5000;
const CHAT_TIMEOUT_MS = 120000; // fallback only — callers that care pass their own signal

export function normalizeBaseUrl(baseUrl) {
  return (baseUrl || '').trim().replace(/\/+$/, '');
}

// One request, no built-in timeout. Resolves with the raw IncomingMessage
// (a Node Readable — iterate it for a stream, or hand it to readBody()).
// Aborting `signal` destroys the request; that surfaces as an AbortError here.
function ollamaHttpRequest(base, apiPath, { method = 'GET', body, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(apiPath, `${base}/`);
    } catch {
      reject(new Error('no Ollama URL is configured'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = mod.request(
      url,
      {
        method,
        signal,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      resolve
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// Translate a raw network / abort error into something a person reading the
// Settings panel can act on. Anything unrecognised is passed through as-is.
function mapOllamaError(err, { base, signal, timeoutMs } = {}) {
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
    return new Error(
      signal
        ? 'the Ollama request was cancelled or ran past its timeout'
        : `Ollama didn't respond within ${Math.round((timeoutMs || 0) / 1000)}s — is it running at ${base}?`
    );
  }
  if (err.code === 'ECONNREFUSED') return new Error(`Nothing is listening at ${base} — is Ollama running?`);
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    return new Error(`Can't resolve the Ollama host in "${base}" — check the URL.`);
  }
  return err;
}

// Buffered request — the small JSON endpoints (tags, show, ps, version) and
// the non-streaming chat. Returns a tiny Response-ish shape so callers keep
// using `.json()` / `.text()`. A caller that passes its own `signal` owns the
// timeout; the rest get the internal `timeoutMs` fallback.
async function ollamaFetch(baseUrl, apiPath, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('no Ollama URL is configured');

  let controller;
  let timer;
  let activeSignal = signal;
  if (!activeSignal) {
    controller = new AbortController();
    activeSignal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await ollamaHttpRequest(base, apiPath, { method, body, signal: activeSignal });
    const text = await readBody(res);
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    if (!ok) {
      let detail = text;
      try { detail = JSON.parse(text).error || text; } catch { /* not JSON — use the raw body */ }
      throw new Error(
        `Ollama ${method} ${apiPath} failed (${res.statusCode})${detail ? `: ${String(detail).slice(0, 200)}` : ''}`
      );
    }
    return { ok, status: res.statusCode, json: () => JSON.parse(text), text: () => text };
  } catch (err) {
    throw mapOllamaError(err, { base, signal, timeoutMs });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// GET /api/tags — the installed models, for the Settings dropdown.
export async function listModels(baseUrl) {
  const res = await ollamaFetch(baseUrl, '/api/tags');
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size ?? null,
    family: m.details?.family ?? null,
    parameterSize: m.details?.parameter_size ?? null,
  }));
}

// GET /api/version — a cheap "is anything there" check.
export async function pingOllama(baseUrl) {
  const res = await ollamaFetch(baseUrl, '/api/version');
  return res.json();
}

// POST /api/show — model metadata. The context window lives under model_info
// as "<family>.context_length" (e.g. "llama.context_length") — backs the Code
// view's context meter. `capabilities` (["completion","vision","tools",...])
// tells the Code agent whether a model can be the vision "eyes" (4a) or drive
// tool calls; older Ollama omits it, so fall back to a projector / family hint.
export async function showModel(baseUrl, name) {
  if (!name) return { contextLength: null, capabilities: [], vision: false, tools: false };
  const res = await ollamaFetch(baseUrl, '/api/show', { method: 'POST', body: { name } });
  const data = await res.json();
  const info = data.model_info || {};
  const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
  const vision =
    capabilities.includes('vision') ||
    !!data.projector_info ||
    (data.details?.families || []).some((f) => /clip|vision|mllama|(^|-)vl($|-)/i.test(String(f)));
  return {
    contextLength: key ? Number(info[key]) || null : null,
    capabilities,
    vision,
    tools: capabilities.includes('tools'),
  };
}

// GET /api/ps — models currently held in memory. Used to tell "the toggle
// is on" from "the model is actually loaded and ready".
export async function listRunningModels(baseUrl) {
  const res = await ollamaFetch(baseUrl, '/api/ps');
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

// A chat with empty messages loads (keep_alive > 0) or evicts (keep_alive: 0)
// the model without generating anything — Ollama's documented preload trick.
export async function preloadModel(baseUrl, model, keepAlive) {
  if (!model) throw new Error('no model selected');
  await ollamaFetch(baseUrl, '/api/chat', {
    method: 'POST',
    body: { model, messages: [], keep_alive: keepAlive || '30m' },
    timeoutMs: 60000, // a cold load of a big model genuinely can take this long
  });
}

export async function unloadModel(baseUrl, model) {
  if (!model) return;
  await ollamaFetch(baseUrl, '/api/chat', {
    method: 'POST',
    body: { model, messages: [], keep_alive: 0 },
    timeoutMs: 15000,
  });
}

// POST /api/chat, non-streaming — returns the whole reply at once. Used by
// the Settings "test message" button, the in-turn compaction summary, and the
// vision "eyes" describe call. `think: false` turns off a reasoning model's
// chain-of-thought when the caller just wants the answer (the vision describe
// does — a thinking trace would blow its time budget).
export async function chat(
  baseUrl,
  { model, messages, keepAlive, numPredict, think, signal, timeoutMs = CHAT_TIMEOUT_MS }
) {
  if (!model) throw new Error('no model selected');
  const body = { model, messages, stream: false, keep_alive: keepAlive || '30m' };
  if (numPredict > 0) body.options = { num_predict: numPredict };
  if (think === false) body.think = false;

  const res = await ollamaFetch(baseUrl, '/api/chat', { method: 'POST', body, signal, timeoutMs });
  const data = await res.json();
  const content = (data.message?.content ?? '').trim();
  if (!content) throw new Error('Ollama returned an empty reply');
  return content;
}

// POST /api/chat with stream:true — Ollama sends newline-delimited JSON, one
// object per token-ish chunk plus a final {done:true}. `onDelta(fullText)`
// is called with the running total as it grows (ollamaChat.js debounces the
// broadcast from there). Returns { content, toolCalls } — `toolCalls` is
// non-empty when the model wants a tool run before it answers (ollamaChat.js
// executes them and calls back in). The caller owns the AbortController;
// there's no internal timeout because a stream that's actively producing
// tokens shouldn't be killed for taking a while (and, before the first token,
// neither should one that's still evaluating a long prompt — see the file
// header for why that used to break).
export async function chatStream(baseUrl, { model, messages, tools, keepAlive, numPredict, numCtx, signal, onDelta }) {
  if (!model) throw new Error('no model selected');
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('no Ollama URL is configured');

  const body = { model, messages, stream: true, keep_alive: keepAlive || '30m' };
  if (tools?.length) body.tools = tools;
  const options = {};
  if (numPredict > 0) options.num_predict = numPredict;
  if (numCtx > 0) options.num_ctx = numCtx;
  if (Object.keys(options).length) body.options = options;

  let res;
  try {
    res = await ollamaHttpRequest(base, '/api/chat', { method: 'POST', body, signal });
  } catch (err) {
    throw mapOllamaError(err, { base, signal });
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let detail = '';
    try { detail = await readBody(res); } catch { /* body may be unreadable after an error status */ }
    try { detail = JSON.parse(detail).error || detail; } catch { /* not JSON */ }
    throw new Error(`Ollama POST /api/chat failed (${res.statusCode})${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let thinking = ''; // "thinking" models (qwen3, ...) stream their reasoning separately — consumed but never shown in chat
  const toolCalls = [];
  try {
    for await (const chunk of res) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) throw new Error(`Ollama: ${obj.error}`);
        if (obj.message?.content) {
          full += obj.message.content;
          onDelta?.(full);
        }
        if (obj.message?.thinking) thinking += obj.message.thinking;
        if (obj.message?.tool_calls?.length) toolCalls.push(...obj.message.tool_calls);
      }
    }
  } catch (err) {
    throw mapOllamaError(err, { base, signal });
  }
  // Not thrown on empty here — a tool-loop round legitimately returns just
  // tool_calls (no content), and the caller decides what an empty final
  // round means (see generateReply in ollamaChat.js).
  return { content: full.trim(), toolCalls, thinking: thinking.trim() };
}
