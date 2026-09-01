// Runs a foreground shell command for the Code agent's run_command tool.
// (Backgrounded ones — a dev server, a watcher — go through codeBackground.js.)
//
// Same child_process.exec + timeout + windowsHide shape as
// serviceControl.js#runControlCommand, but with the workspace folder (or a
// subdir of it) as the working directory, a timeout from config.code, and a
// bigger captured-output budget. Like serviceControl it never throws — a
// non-zero exit or a timeout comes back in the result object.
//
// This does NOT sandbox the command: it runs as the Mission Control process
// user and can do whatever that user can. That's inherent to "run commands",
// which is why the tool is off by default (config.code.allowCommands), gated
// behind the password like the rest of the Code feature, confirmed in chat
// unless the session is in auto-all mode, and activity-logged. Same trust
// model as Service Control.

import { exec } from 'node:child_process';
import { resolveWorkspacePath, ensureWorkspace, safeResolve } from './codeWorkspace.js';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_CHARS = 20000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

function truncate(s) {
  if (!s) return '';
  return s.length > MAX_OUTPUT_CHARS
    ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated at ${MAX_OUTPUT_CHARS} characters]`
    : s;
}

export function commandTimeoutMs(config) {
  return Math.max(1000, Math.min(600000, config.code?.commandTimeoutMs || DEFAULT_TIMEOUT_MS));
}

// Returns { exitCode, stdout, stderr, timedOut } — always resolves. A caller
// with its own budget (run_checks — a test suite runs longer than an ad-hoc
// command) passes timeoutMs to override config.code.commandTimeoutMs.
export async function runInWorkspace(config, command, { cwdRel = '', timeoutMs } = {}) {
  await ensureWorkspace(config);
  const cwd = cwdRel ? safeResolve(config, cwdRel) : resolveWorkspacePath(config);
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(1200000, timeoutMs)) : commandTimeoutMs(config);

  return new Promise((resolve) => {
    exec(command, { cwd, timeout, windowsHide: true, maxBuffer: EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
      const timedOut = !!(err && err.killed);
      let exitCode = 0;
      if (err) exitCode = typeof err.code === 'number' ? err.code : 1;
      resolve({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr), timedOut });
    });
  });
}
