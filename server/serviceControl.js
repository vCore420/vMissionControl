// Runs a service's configured start/stop/restart command on the host.
// Commands are plain shell strings Vi authors themselves in the Add/Edit
// Service modal (not user-supplied per request), so the risk here isn't
// injection — it's an unauthorized party triggering a command Vi already
// wrote. That's why routes/services.js gates every call behind both the
// serviceControl.enabled switch and auth.enabled, on top of this module
// just running whatever string it's given via the shell.

import { exec } from 'node:child_process';
import { loadConfig } from './config.js';
import { dockerContainerAction } from './docker.js';
import { checkOneService } from './healthChecker.js';
import { logActivity } from './activityLog.js';

const COMMAND_TIMEOUT_MS = 20000;
const MAX_OUTPUT_CHARS = 4000;

const CONTROL_VERBS = { start: 'start', stop: 'stop', restart: 'restart' };
const SCRIPT_FIELD = { start: 'startCmd', stop: 'stopCmd', restart: 'restartCmd' };

function truncate(text) {
  if (!text) return '';
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
}

export function runControlCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          output: truncate(stdout),
          error: truncate(err.killed ? 'command timed out' : stderr || err.message),
        });
        return;
      }
      resolve({ ok: true, output: truncate(stdout || stderr) });
    });
  });
}

// The full start/stop/restart flow: the two gate checks (serviceControl.enabled
// + auth.enabled — this runs commands on the host), dispatch to the script
// or Docker controller, activity-log both attempt and outcome, and schedule
// a recheck so the status dot catches up. Shared by routes/services.js and
// the assistant's control_service action tool. Returns { ok, output } or
// { ok: false, error } — never throws, never touches res.
export async function controlService(serviceId, action, { via = 'the dashboard' } = {}) {
  const verb = CONTROL_VERBS[action];
  if (!verb) return { ok: false, error: `unsupported action: ${action}` };

  const config = await loadConfig();
  if (!config.security?.serviceControl?.enabled) {
    return { ok: false, error: 'Service Control is off — turn it on in Settings → Security.' };
  }
  if (!config.auth?.enabled) {
    return { ok: false, error: 'Service Control needs password protection enabled first.' };
  }

  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return { ok: false, error: 'service not found' };
  if (!service.controller) return { ok: false, error: `"${service.name}" has no control commands configured` };

  let result;
  if (service.controller.type === 'script') {
    const cmd = service.controller[SCRIPT_FIELD[action]];
    if (!cmd) return { ok: false, error: `no ${verb} command configured for "${service.name}"` };
    result = await runControlCommand(cmd);
  } else if (service.controller.type === 'docker') {
    try {
      await dockerContainerAction(service.controller.container, action);
      result = { ok: true, output: `Docker ${verb} sent to "${service.controller.container}"` };
    } catch (err) {
      result = { ok: false, error: err.message };
    }
  } else {
    return { ok: false, error: 'unsupported controller type' };
  }

  logActivity(
    'control',
    result.ok
      ? `"${service.name}" ${verb} succeeded (via ${via})`
      : `"${service.name}" ${verb} failed: ${result.error || 'unknown error'} (via ${via})`
  );
  setTimeout(() => {
    checkOneService(loadConfig, service.id).catch(() => {});
  }, 3000);

  return result;
}
