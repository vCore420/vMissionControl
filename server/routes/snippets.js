// Creative roadmap, Phase 2 — the Snippets settings tab. One GET for the
// whole panel, one PUT to save the list + runner switch, one POST to run a
// saved snippet.
//
// Editing the list needs the app's normal session (like editing services).
// RUNNING a snippet runs a command on the host, so /run is gated behind BOTH
// config.auth.enabled AND config.security.snippetRunner.enabled — the same
// double lock service control uses — and only ever runs a command string
// that's already in config.snippets, never one from the request body.

import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { loadCatalog, sanitizeSnippets, runSnippet, snippetRunnerTimeoutMs } from '../snippets.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const snippetsRouter = Router();

snippetsRouter.get('/', async (req, res) => {
  const config = await loadConfig();
  res.json({
    snippets: config.snippets || [],
    runner: {
      enabled: !!config.security?.snippetRunner?.enabled,
      timeoutMs: snippetRunnerTimeoutMs(config),
    },
    catalog: await loadCatalog(),
    hostPlatform: process.platform, // 'win32' | 'linux' | 'darwin' — the UI flags a catalog mismatch
    authEnabled: !!config.auth?.enabled,
  });
});

// Saves the list AND the runner switch/timeout in one call (the tab has one
// Save button, like the Code tab). The switch can't go on without a password,
// same rule as service control.
snippetsRouter.put('/', async (req, res) => {
  const config = await loadConfig();
  const body = req.body || {};

  const snippets = sanitizeSnippets(body.snippets);

  const cur = config.security?.snippetRunner || { enabled: false, timeoutMs: 60000 };
  const wantsEnabled = body.runner?.enabled !== undefined ? !!body.runner.enabled : cur.enabled;
  if (wantsEnabled && !config.auth?.enabled) {
    return res.status(400).json({ error: 'enable password protection before turning on the snippet runner' });
  }
  const timeoutMs = snippetRunnerTimeoutMs({ security: { snippetRunner: { timeoutMs: body.runner?.timeoutMs ?? cur.timeoutMs } } });
  const wasEnabled = !!cur.enabled;

  config.snippets = snippets;
  config.security = { ...config.security, snippetRunner: { enabled: wantsEnabled, timeoutMs } };
  await saveConfig(config);

  if (wasEnabled !== wantsEnabled) {
    logActivity('security', `Snippet runner ${wantsEnabled ? 'enabled' : 'disabled'}`, clientIp(req));
  } else {
    logActivity('settings', `Updated snippets (${snippets.length})`, clientIp(req));
  }
  res.json({ snippets: config.snippets, runner: config.security.snippetRunner });
});

snippetsRouter.post('/:id/run', async (req, res) => {
  const config = await loadConfig();
  if (!config.security?.snippetRunner?.enabled) {
    return res.status(403).json({ error: 'the snippet runner is off — turn it on in Settings → Snippets' });
  }
  if (!config.auth?.enabled) {
    return res.status(403).json({ error: 'the snippet runner needs password protection enabled first' });
  }
  const snippet = (config.snippets || []).find((s) => s.id === req.params.id);
  if (!snippet) return res.status(404).json({ error: 'snippet not found' });

  logActivity('control', `Ran snippet "${snippet.label}"`, clientIp(req));
  const result = await runSnippet(config, snippet);
  logActivity(
    'control',
    result.timedOut
      ? `Snippet "${snippet.label}" timed out`
      : `Snippet "${snippet.label}" exited ${result.exitCode} (${result.ms} ms)`,
    clientIp(req)
  );
  res.json(result);
});
