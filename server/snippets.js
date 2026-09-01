// Creative roadmap, Phase 2 — the snippet runner. `config.snippets` is a list
// of shell commands you've saved (hand-typed or added from the shipped
// catalog); this module validates that list and runs one entry on demand.
//
// Running a snippet runs a command on the host as the Mission Control process
// user — exactly the Service Control threat model — so routes/snippets.js
// gates the run endpoint behind BOTH config.auth.enabled AND
// config.security.snippetRunner.enabled, and only ever runs a string that was
// already saved (never one from the request body). Editing the list only
// needs auth; nothing runs until the switch is on.

import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { resolveWorkspacePath } from './codeWorkspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, 'data', 'snippets-catalog.json');

const MAX_SNIPPETS = 40;
const MAX_LABEL = 60;
const MAX_COMMAND = 800;
const MAX_CWD = 400;
const MAX_OUTPUT_CHARS = 20000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;

let catalogCache = null;

export async function loadCatalog() {
  if (!catalogCache) {
    try {
      catalogCache = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf-8'));
    } catch {
      catalogCache = { checks: [], snippets: [] };
    }
  }
  return catalogCache;
}

let snippetSeq = 0;
function newId() {
  return `snip-${Date.now().toString(36)}-${(snippetSeq++).toString(36)}`;
}

// Normalises a client-supplied list into what gets stored. Keeps a stable id
// per row (generates one when missing), trims + length-caps every field,
// drops rows with no label or command, caps the count.
export function sanitizeSnippets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => ({
      id: typeof s?.id === 'string' && /^snip-[a-z0-9-]{1,40}$/.test(s.id) ? s.id : newId(),
      label: typeof s?.label === 'string' ? s.label.trim().slice(0, MAX_LABEL) : '',
      command: typeof s?.command === 'string' ? s.command.trim().slice(0, MAX_COMMAND) : '',
      cwd: typeof s?.cwd === 'string' ? s.cwd.trim().slice(0, MAX_CWD) : '',
    }))
    .filter((s) => s.label && s.command)
    .slice(0, MAX_SNIPPETS);
}

export function snippetRunnerTimeoutMs(config) {
  const n = Math.round(Number(config.security?.snippetRunner?.timeoutMs));
  return Number.isFinite(n) ? Math.min(1200000, Math.max(5000, n)) : DEFAULT_TIMEOUT_MS;
}

function truncate(s) {
  if (!s) return '';
  return s.length > MAX_OUTPUT_CHARS
    ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated at ${MAX_OUTPUT_CHARS} characters]`
    : s;
}

// Where a snippet runs: its own `cwd` if set (absolute as-is, otherwise
// resolved against the Code workspace), else the workspace root. Never throws
// on a bad path — falls back to the workspace so a typo can't crash the call.
function resolveCwd(config, snippet) {
  const base = resolveWorkspacePath(config);
  if (!snippet.cwd) return base;
  return path.isAbsolute(snippet.cwd) ? snippet.cwd : path.resolve(base, snippet.cwd);
}

// Runs one saved snippet. Returns { exitCode, stdout, stderr, timedOut, ms } —
// always resolves, same shape as codeExec.js.
export async function runSnippet(config, snippet) {
  const cwd = resolveCwd(config, snippet);
  const timeout = snippetRunnerTimeoutMs(config);
  const started = Date.now();

  // A cwd that doesn't exist would make exec throw synchronously in the
  // callback with ENOENT and no useful message — check first.
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) return { exitCode: 1, stdout: '', stderr: `working directory is not a folder: ${cwd}`, timedOut: false, ms: 0 };
  } catch {
    return { exitCode: 1, stdout: '', stderr: `working directory not found: ${cwd}`, timedOut: false, ms: 0 };
  }

  return new Promise((resolve) => {
    exec(snippet.command, { cwd, timeout, windowsHide: true, maxBuffer: EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut: !!(err && err.killed),
        ms: Date.now() - started,
      });
    });
  });
}
