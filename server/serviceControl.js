// Runs a service's configured start/stop/restart command on the host.
// Commands are plain shell strings Vi authors themselves in the Add/Edit
// Service modal (not user-supplied per request), so the risk here isn't
// injection — it's an unauthorized party triggering a command Vi already
// wrote. That's why routes/services.js gates every call behind both the
// serviceControl.enabled switch and auth.enabled, on top of this module
// just running whatever string it's given via the shell.

import { exec } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 20000;
const MAX_OUTPUT_CHARS = 4000;

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
