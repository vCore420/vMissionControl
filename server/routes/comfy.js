import { Router } from 'express';
import { loadConfig } from '../config.js';
import { pingComfy, listCheckpoints, getQueue } from '../comfy.js';
import { validateWorkflow, autodetectMapping, mappingSummary } from '../comfyImage.js';

export const comfyRouter = Router();

// All three of these back the Settings → ComfyUI panel, so they only need the
// app's normal session (same as GET /api/ollama/models) — gating them behind
// config.comfy.enabled would be circular, you need them to turn it on. 502 on
// an upstream failure, not 500: an unreachable ComfyUI is its problem, not a
// bug here, and the panel shows the message verbatim.

// Reachability + device/VRAM (so you can see whether ComfyUI found your GPU)
// + queue depth. Reads whichever baseUrl is currently *saved*.
comfyRouter.get('/status', async (req, res) => {
  const { comfy } = await loadConfig();
  try {
    const info = await pingComfy(comfy.baseUrl);
    const queue = await getQueue(comfy.baseUrl).catch(() => null);
    res.json({ reachable: true, ...info, queue });
  } catch (err) {
    res.status(502).json({ reachable: false, error: err.message });
  }
});

// Installed checkpoints, for the model dropdown.
comfyRouter.get('/checkpoints', async (req, res) => {
  const { comfy } = await loadConfig();
  try {
    res.json({ checkpoints: await listCheckpoints(comfy.baseUrl) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Paste a workflow → get back the auto-detected node mapping (and whether it's
// even a valid API-format workflow). Runs on the posted text, not the saved
// one, so the "Detect" button works before Save.
comfyRouter.post('/detect', (req, res) => {
  const check = validateWorkflow(req.body?.workflow || '');
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  const mapping = autodetectMapping(check.workflow);
  res.json({
    ok: true,
    mapping,
    summary: mappingSummary(mapping),
    nodeCount: Object.keys(check.workflow).length,
    hasPrompt: !!mapping.prompt?.node,
  });
});
