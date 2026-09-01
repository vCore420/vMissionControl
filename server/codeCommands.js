// Custom `/commands` for the Code composer (Code parity roadmap 3b).
//
// A command is a prompt template the user triggers with `/name args`. Three
// are built in (`/review`, `/test`, `/explain`); a workspace can add its own
// as `<workspace>/.mc/commands/<name>.md`, and a file wins over a built-in of
// the same name. `$ARGUMENTS` in the body is replaced with whatever the user
// typed after the command (if the body has no `$ARGUMENTS`, the args are
// appended). Optional frontmatter — `description`, `model`, `approvalMode` —
// overrides the session's model / approval mode for that one turn.
//
// The composer sends the raw `/name args` as the message text (that's what the
// transcript shows); routes/code.js expands it here and hands runTurn the
// expanded prompt + any overrides.

import fs from 'node:fs/promises';
import path from 'node:path';
import { safeResolve } from './codeWorkspace.js';

const COMMANDS_DIR = '.mc/commands';
const MAX_BODY_BYTES = 16_000;
const APPROVAL_MODES = new Set(['ask', 'auto-edit', 'auto-all']);
const NAME_RE = /^[a-z0-9][\w-]{0,39}$/;

const BUILTINS = {
  review: {
    description: 'Review code for bugs, risks, and rough edges',
    body:
      'Review the code for correctness, risks, and rough edges. $ARGUMENTS\n\n' +
      'Read the relevant files first — never review from memory. Run the configured checks if there are any. ' +
      'Report concrete findings: the file and line (write it as path:line), what is wrong, why it matters, and a ' +
      'suggested fix. Put the most serious first. If something is fine, say so plainly rather than inventing problems.',
  },
  test: {
    description: 'Run the configured checks and fix what fails',
    body:
      "Run the project's configured checks with run_checks. $ARGUMENTS\n\n" +
      'Report what passed and what failed. For each failure, read the relevant code, work out the cause, and fix ' +
      "it, then re-run the checks. Stop when they pass or you're genuinely blocked. If no checks are configured, say so.",
  },
  explain: {
    description: 'Explain how part of the code works',
    body:
      'Explain how this works, clearly and concretely: $ARGUMENTS\n\n' +
      'Read the actual code involved — do not guess. Walk through the flow: the entry point, the key steps, the ' +
      'data. Point at specific spots as path:line. Keep it to what matters; skip the obvious.',
  },
};

// Split `---\n…\n---\n<body>` frontmatter. Returns { meta, body }.
function parseFrontmatter(raw) {
  const text = String(raw);
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: text };
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body };
}

function expand(body, args) {
  const a = String(args || '').trim();
  if (body.includes('$ARGUMENTS')) return body.split('$ARGUMENTS').join(a);
  return a ? `${body.trim()}\n\n${a}` : body.trim();
}

async function readWorkspaceCommands(config) {
  let dir;
  try {
    dir = safeResolve(config, COMMANDS_DIR);
  } catch {
    return {};
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return {}; // no .mc/commands — fine
  }
  const out = {};
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const name = e.name.slice(0, -3).toLowerCase();
    if (!NAME_RE.test(name)) continue;
    let raw;
    try {
      raw = await fs.readFile(path.join(dir, e.name), 'utf-8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw.slice(0, MAX_BODY_BYTES));
    if (!body.trim()) continue;
    out[name] = {
      description: (meta.description || '').slice(0, 120),
      body,
      model: meta.model ? meta.model.slice(0, 80) : undefined,
      approvalMode: APPROVAL_MODES.has(meta.approvalmode) ? meta.approvalmode : undefined,
    };
  }
  return out;
}

// For the composer's `/` picker: [{ name, description, source }], sorted.
export async function listCommands(config) {
  const ws = await readWorkspaceCommands(config);
  const names = new Set([...Object.keys(BUILTINS), ...Object.keys(ws)]);
  return [...names]
    .sort()
    .map((name) => {
      const def = ws[name] || BUILTINS[name];
      return {
        name,
        description: def.description || '',
        source: ws[name] ? 'workspace' : 'builtin',
      };
    });
}

// Expand `/name args`. Returns { name, prompt, model?, approvalMode?, source }
// or null if there's no such command.
export async function resolveCommand(config, name, args) {
  const key = String(name || '').toLowerCase();
  if (!NAME_RE.test(key)) return null;
  const ws = await readWorkspaceCommands(config);
  const def = ws[key] || BUILTINS[key];
  if (!def) return null;
  return {
    name: key,
    source: ws[key] ? 'workspace' : 'builtin',
    prompt: expand(def.body, args),
    model: def.model,
    approvalMode: def.approvalMode,
  };
}
