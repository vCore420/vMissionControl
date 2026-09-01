import { Router } from 'express';
import { loadConfig } from '../config.js';
import { listModels, chat, pingOllama } from '../ollama.js';
import { setActive, getStatus } from '../ollamaChat.js';
import { decideAction } from '../ollamaActions.js';
import { clientIp } from '../net.js';

export const ollamaRouter = Router();

// Live model list for the Settings dropdown, read from whichever Ollama URL
// is currently *saved* (save the URL first, then refresh — same "test what's
// stored, not the unsaved form" contract as the alerts test button).
//
// 502, not 500: an unreachable Ollama is an upstream failure, not a bug in
// this server, and the Settings panel shows this message verbatim so the
// person knows to check the URL / start Ollama.
ollamaRouter.get('/models', async (req, res) => {
  const config = await loadConfig();
  try {
    const models = await listModels(config.ollama.baseUrl);
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Whether the assistant is on, whether Ollama answers, and whether the
// selected model is actually resident. The Chat-view toggle polls this
// while it's on to show "starting…" → "ready".
ollamaRouter.get('/status', async (req, res) => {
  res.json(await getStatus());
});

// The Chat-view toggle. Flipping it persists config.ollama.active (which
// broadcasts to every device) and loads or evicts the model. Returns
// immediately with the current status — the preload continues server-side
// and the client polls /status for "ready".
ollamaRouter.post('/active', async (req, res) => {
  try {
    const status = await setActive(!!req.body?.active, clientIp(req));
    res.json(status);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// One round-trip through the whole saved config — proves the URL, the
// model, and the system prompt all work before you rely on it in chat.
// Tests what's *saved*, so save first (same as the alerts test button).
ollamaRouter.post('/test', async (req, res) => {
  const { ollama } = await loadConfig();
  if (!ollama.model) return res.status(400).json({ error: 'pick a model first' });
  try {
    await pingOllama(ollama.baseUrl);
    const startedAt = Date.now();
    const reply = await chat(ollama.baseUrl, {
      model: ollama.model,
      messages: [
        ...(ollama.systemPrompt ? [{ role: 'system', content: ollama.systemPrompt }] : []),
        { role: 'user', content: 'Reply with a short one-line greeting so I know you are working.' },
      ],
      keepAlive: ollama.keepAlive,
      numPredict: Math.min(ollama.numPredict || 100, 100),
      timeoutMs: 45000,
    });
    res.json({ ok: true, reply, ms: Date.now() - startedAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Confirm or cancel a pending assistant action (the Confirm/Cancel card in
// chat). Only reachable with a valid session — the whole actions feature
// requires password protection — and only a `confirm` decision runs the
// tool; the card is patched in place for every device via chat's WS.
ollamaRouter.post('/action/:id', async (req, res) => {
  const decision = req.body?.decision === 'confirm' ? 'confirm' : 'cancel';
  const result = await decideAction(req.params.id, decision, clientIp(req));
  if (result.error) return res.status(result.status === 'failed' ? 502 : 400).json(result);
  res.json(result);
});
