// Scheduled tasks (ops roadmap Phase 4) — the Settings → Scheduled tab.
// One GET for the whole panel (the list plus the snippet/service options its
// dropdowns need), one PUT to save the list, one POST to run a task now.
//
// Editing needs only the normal session, like editing snippets — a task
// can't actually run anything until the switch its action depends on (the
// snippet runner / Service Control, each of which needs a password) is on.
// server/scheduler.js enforces that at fire time.

import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { sanitizeSchedules, describeWhen, runScheduleNow } from '../scheduler.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const schedulesRouter = Router();

function panelData(config) {
  return {
    schedules: (config.schedules || []).map((s) => ({ ...s, whenText: describeWhen(s.when) })),
    snippets: (config.snippets || []).map((s) => ({ id: s.id, label: s.label })),
    gameServices: (config.services || []).filter((s) => s.game?.kind).map((s) => ({ id: s.id, name: s.name })),
    restartServices: (config.services || [])
      .filter((s) => s.controller)
      .map((s) => ({ id: s.id, name: s.name })),
    gates: {
      auth: !!config.auth?.enabled,
      snippetRunner: !!config.security?.snippetRunner?.enabled,
      serviceControl: !!config.security?.serviceControl?.enabled,
      comfy: !!config.comfy?.enabled,
      webhook: !!config.alerts?.webhookUrl,
    },
  };
}

schedulesRouter.get('/', async (req, res) => {
  res.json(panelData(await loadConfig()));
});

schedulesRouter.put('/', async (req, res) => {
  const config = await loadConfig();
  const { schedules, error } = sanitizeSchedules(req.body?.schedules, config.schedules || []);
  if (error) return res.status(400).json({ error });

  config.schedules = schedules;
  await saveConfig(config);
  logActivity('settings', `Updated scheduled tasks (${schedules.length})`, clientIp(req));
  res.json(panelData(config));
});

schedulesRouter.post('/:id/run', async (req, res) => {
  const { result, lastRun, lastResult, error } = await runScheduleNow(req.params.id);
  if (error) return res.status(404).json({ error });
  res.json({ result, lastRun, lastResult });
});
