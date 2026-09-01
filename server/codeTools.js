// Every tool the Code agent can call, workspace-scoped via
// codeWorkspace.js#safeResolve so nothing here reaches outside the session's
// working directory.
//
//   REGISTRY        read-only, run directly: list_dir, read_file, search_text,
//                   find_files, run_checks, check_command, stop_command.
//   WRITE_REGISTRY  mutating / approval-gated {prepare, execute} pairs:
//                   write_file, edit_file, append_file, create_dir,
//                   delete_path, run_command, generate_image. prepare() builds
//                   a diff and checks the relevant switch; codeAgent.js runs
//                   the approval flow, then execute().
//   definition-only ASK_USER_TOOL, UPDATE_TASKS_TOOL — codeAgent.js intercepts
//                   these before dispatch and handles them itself.
//
// getCodeToolDefinitions() assembles the list the model actually sees for a
// turn, hiding tools whose feature is off or that the user switched off
// (config.code.disabledTools). Adding a read tool = one REGISTRY entry.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import {
  resolveWorkspacePath, safeResolve, writeBinaryFile, listDir as wsListDir, WorkspacePathError,
} from './codeWorkspace.js';
import { unifiedDiff, diffStat } from './textDiff.js';
import { runInWorkspace, commandTimeoutMs } from './codeExec.js';
import { startBackground, checkBackground, stopBackground } from './codeBackground.js';
import { looksBinary } from './textFiles.js';
import { buildWorkflow, generate as comfyGenerate } from './comfyImage.js';

// Directories a code walk should never descend into — build output, vendored
// deps, VCS metadata. Keeps search fast and its results relevant.
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', 'dist', 'build', 'out',
  '.next', '.nuxt', '.output', '.svelte-kit', '__pycache__', '.venv', 'venv',
  '.tox', 'coverage', '.gradle', 'target', 'vendor', '.terraform',
]);
const MAX_FILES_SCANNED = 4000;   // hard cap so a huge tree can't tie up the event loop
const MAX_MATCHES = 100;
const CONTENT_MAX_FILE_BYTES = 512 * 1024; // don't grep files bigger than this
const READ_DEFAULT_LINES = 400;
const READ_MAX_BYTES = 200 * 1024;

// search_text guards. The regex comes straight from the model when regex:true,
// and re.test() runs synchronously over every line — a pathological pattern
// stalls the whole event loop. A real code search never needs a long pattern
// or a quantified group, so reject both, cap how much of any one line is
// tested, and give the whole scan a wall-clock budget.
const MAX_PATTERN_LEN = 1000;
const SEARCH_BUDGET_MS = 4000;
const LINE_TEST_MAX_CHARS = 8000;

// Catastrophic-backtracking shapes a confused model actually reaches for:
// a group that contains a quantifier or an alternation, immediately
// quantified again — (a+)+, (.*)*, (a{2,})+, (x|y)*. Not a full ReDoS
// analysis, just the classic exponential cases.
function looksCatastrophic(source) {
  return /\([^)]*[+*}?][^)]*\)\s*[+*{]/.test(source) || /\([^)]*\|[^)]*\)\s*[+*{]/.test(source);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

// Minimal glob → RegExp. `*` matches within one path segment, `**` across
// segments, and a leading `**/` matches zero or more segments (so "**/x"
// matches a root-level "x", not only "dir/x"). `?` is one non-slash char.
// No character classes.
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchGlob(p, glob) {
  return globToRegExp(glob).test(p);
}

// Recursive walk yielding workspace-relative file paths, skipping IGNORE_DIRS
// and stopping at MAX_FILES_SCANNED.
async function* walkFiles(root, startRel, state) {
  if (state.scanned >= MAX_FILES_SCANNED) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, startRel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.scanned >= MAX_FILES_SCANNED) return;
    const rel = startRel ? `${startRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) yield* walkFiles(root, rel, state);
    } else if (entry.isFile()) {
      state.scanned += 1;
      yield rel;
    }
  }
}

// ---------- Handlers ----------

async function listDirHandler(args) {
  const config = await loadConfig();
  try {
    return await wsListDir(config, args.path || '');
  } catch (err) {
    if (err instanceof WorkspacePathError) return { error: err.message };
    return { error: `can't list "${args.path || '/'}" — ${err.message}` };
  }
}

async function readFileHandler(args) {
  if (!args.path) return { error: 'a file path is required' };
  const config = await loadConfig();
  let target;
  try {
    target = safeResolve(config, args.path);
  } catch (err) {
    return { error: err.message };
  }
  let buf;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return { error: 'that path is a directory — use list_dir' };
    buf = await fs.readFile(target);
  } catch {
    return { error: `no file at "${args.path}"` };
  }
  if (looksBinary(buf)) return { path: args.path, note: 'this looks like a binary file — not shown' };

  const allLines = buf.toString('utf-8').split('\n');
  const totalLines = allLines.length;
  const offset = Number.isFinite(+args.offset) && +args.offset > 0 ? Math.floor(+args.offset) : 1;
  const limit = Number.isFinite(+args.limit) && +args.limit > 0 ? Math.floor(+args.limit) : READ_DEFAULT_LINES;
  const start = offset - 1;
  const slice = allLines.slice(start, start + limit);
  let content = slice.join('\n');
  let bytesTruncated = false;
  if (content.length > READ_MAX_BYTES) {
    content = content.slice(0, READ_MAX_BYTES);
    bytesTruncated = true;
  }
  const lastLine = Math.min(totalLines, start + slice.length);
  return {
    path: args.path,
    totalLines,
    shownRange: `${offset}-${lastLine}`,
    truncated: bytesTruncated || lastLine < totalLines,
    content,
  };
}

async function searchTextHandler(args) {
  const query = String(args.query || '');
  if (!query) return { error: 'a search query is required' };
  if (query.length > MAX_PATTERN_LEN) {
    return { error: `search pattern is too long (max ${MAX_PATTERN_LEN} characters)` };
  }
  const config = await loadConfig();
  const root = resolveWorkspacePath(config);

  let re;
  try {
    if (args.regex && looksCatastrophic(query)) {
      return {
        error:
          'that regex has a quantified group that can backtrack catastrophically — drop the group or the outer +/*, or search for a plain substring',
      };
    }
    const source = args.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(source, 'i');
  } catch (err) {
    return { error: `bad regex: ${err.message}` };
  }

  let scopeRel = '';
  if (args.path) {
    try {
      safeResolve(config, args.path); // validate it's in-bounds
      scopeRel = String(args.path).replace(/^[./]+|\/+$/g, '');
    } catch (err) {
      return { error: err.message };
    }
  }

  const matches = [];
  let truncated = false;
  const state = { scanned: 0 };
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  for await (const rel of walkFiles(root, scopeRel, state)) {
    if (matches.length >= MAX_MATCHES) { truncated = true; break; }
    if (Date.now() > deadline) { truncated = 'time'; break; }
    if (args.glob && !matchGlob(rel, args.glob)) continue;
    let buf;
    try {
      buf = await fs.readFile(path.join(root, rel));
    } catch {
      continue;
    }
    if (buf.length > CONTENT_MAX_FILE_BYTES || looksBinary(buf)) continue;
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Cap the slice handed to the matcher: a single very long line (a
      // minified file that slipped past the size check) shouldn't be able
      // to make one re.test() call run away. A match past column 8000 in
      // source is vanishingly rare and the shown text is trimmed anyway.
      const line = lines[i].length > LINE_TEST_MAX_CHARS ? lines[i].slice(0, LINE_TEST_MAX_CHARS) : lines[i];
      if (re.test(line)) {
        matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
      }
    }
  }

  return {
    query,
    count: matches.length,
    matches,
    ...(truncated && {
      truncated:
        truncated === 'time'
          ? 'search hit its time budget — narrow it with path or glob'
          : 'stopped at the match/scan limit — narrow the query or use path/glob',
    }),
  };
}

// Flat list of every workspace file (node_modules/.git/etc. skipped), for the
// composer's `@` file picker (Code parity roadmap 3a). Reuses the same walk +
// ignore set the find_files tool uses.
export async function listWorkspaceFiles(config, { limit = 3000 } = {}) {
  const root = resolveWorkspacePath(config);
  const files = [];
  const state = { scanned: 0 };
  let truncated = false;
  for await (const rel of walkFiles(root, '', state)) {
    files.push(rel);
    if (files.length >= limit) { truncated = true; break; }
  }
  return { files, truncated };
}

async function findFilesHandler(args) {
  const query = String(args.query || '').trim();
  if (!query) return { error: 'a name substring or glob is required' };
  const config = await loadConfig();
  const root = resolveWorkspacePath(config);
  const isGlob = /[*?]/.test(query);
  const needle = query.toLowerCase();

  const files = [];
  let truncated = false;
  const state = { scanned: 0 };
  for await (const rel of walkFiles(root, '', state)) {
    const hit = isGlob ? matchGlob(rel, query) : rel.toLowerCase().includes(needle);
    if (hit) {
      files.push(rel);
      if (files.length >= MAX_MATCHES) { truncated = true; break; }
    }
  }
  return { query, count: files.length, files, ...(truncated && { truncated: 'more than the limit — narrow the pattern' }) };
}

const CHECK_TIMEOUT_DEFAULT_MS = 120000;
const CHECK_OUTPUT_MAX = 10000;

async function runChecksHandler(args) {
  const config = await loadConfig();
  const checks = Array.isArray(config.code?.checks) ? config.code.checks : [];
  if (!checks.length) return { error: 'no checks are configured — add them in Settings → Code' };

  const only = Array.isArray(args.only)
    ? args.only.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : null;
  const toRun = only ? checks.filter((c) => only.includes(String(c.label).toLowerCase())) : checks;
  if (only && !toRun.length) {
    return { error: `no check matches ${JSON.stringify(only)} — configured: ${checks.map((c) => c.label).join(', ')}` };
  }

  const timeoutMs = Math.max(5000, Math.min(1200000, config.code?.checkTimeoutMs || CHECK_TIMEOUT_DEFAULT_MS));
  const results = [];
  for (const check of toRun) {
    const res = await runInWorkspace(config, check.command, { timeoutMs });
    const output =
      [res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`].filter(Boolean).join('\n\n') || '(no output)';
    results.push({
      label: check.label,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      ok: !res.timedOut && res.exitCode === 0,
      output: output.slice(0, CHECK_OUTPUT_MAX),
    });
  }
  return {
    summary: results
      .map((r) => `${r.label} ${r.ok ? '✓' : r.timedOut ? '⏱ timed out' : `✕ exit ${r.exitCode}`}`)
      .join('  ·  '),
    allPassed: results.every((r) => r.ok),
    checks: results,
  };
}

// ---------- Registry ----------

const REGISTRY = [
  {
    name: 'list_dir',
    label: 'list',
    description:
      'List the contents of a directory in the workspace. Omit path for the workspace root. Each entry is marked file or dir with its size.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the workspace root. Default: the root.' } },
    },
    handler: listDirHandler,
  },
  {
    name: 'read_file',
    label: 'read',
    description:
      'Read a text file from the workspace and return its content plus the total line count. For a large file, pass offset and limit (1-based line numbers) to read a slice. Always read a file before describing or changing it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        offset: { type: 'number', description: 'First line to return (1-based). Default 1.' },
        limit: { type: 'number', description: 'How many lines to return. Default 400.' },
      },
      required: ['path'],
    },
    handler: readFileHandler,
  },
  {
    name: 'search_text',
    label: 'search',
    description:
      'Search file contents across the workspace for a string (or a regular expression if regex is true). Returns file path, line number, and the matching line. Use this to find where something is defined or used.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for, or a regex if regex is true.' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        path: { type: 'string', description: 'Restrict the search to this subdirectory.' },
        glob: { type: 'string', description: 'Only search files whose path matches this glob, e.g. "**/*.ts".' },
      },
      required: ['query'],
    },
    handler: searchTextHandler,
  },
  {
    name: 'find_files',
    label: 'find',
    description:
      'Find files in the workspace by name substring or glob pattern (e.g. "**/*.test.js", "tsconfig", "src/**"). Returns matching paths.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A filename substring or a glob pattern.' } },
      required: ['query'],
    },
    handler: findFilesHandler,
  },
  {
    // check_command / stop_command (Code parity 2a) — read + control a
    // background command started by run_command({background:true}). No
    // approval: reading buffered output is harmless, and stopping a process
    // the agent itself started is benign. Only offered alongside run_command
    // (allowCommands on) — see getCodeToolDefinitions.
    name: 'check_command',
    label: 'check',
    description:
      "Read a background command's recent output and whether it is still running. Pass the bgId that run_command({background:true}) returned.",
    parameters: {
      type: 'object',
      properties: { bgId: { type: 'string', description: 'The background command id.' } },
      required: ['bgId'],
    },
    handler: (args) => checkBackground(String(args.bgId || '')),
  },
  {
    name: 'stop_command',
    label: 'stop',
    description: 'Stop a background command (and its child processes). Pass its bgId. Do this when you are done testing against it.',
    parameters: {
      type: 'object',
      properties: { bgId: { type: 'string', description: 'The background command id.' } },
      required: ['bgId'],
    },
    handler: (args) => stopBackground(String(args.bgId || '')),
  },
  {
    // run_checks runs commands, but they're the *user's* — a curated list from
    // Settings, not model input — so it needs no approval and no allowCommands
    // switch, and lives here with the reads. Only offered when at least one
    // check is configured (getCodeToolDefinitions).
    name: 'run_checks',
    label: 'checks',
    description:
      "Run the project's configured checks (whatever the user set up — syntax, a linter, tests) with the workspace as the working directory, and return each one's result. Run this after making changes to verify them, and fix anything that fails. Pass `only` to run a subset by label.",
    parameters: {
      type: 'object',
      properties: {
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: run just these checks by label, e.g. ["test"]. Omit to run all.',
        },
      },
    },
    handler: runChecksHandler,
  },
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.name, t]));

// ---------- Write tools (Phase 3) ----------
//
// These change files, so each is a { prepare, execute } pair — never run
// directly by executeCodeTool. codeAgent.js calls prepare() to validate and
// build a diff for review, decides (from the session's approval mode)
// whether to auto-apply or post a Confirm/Reject card, then calls execute().
// `autoInEditMode: true` means "auto-edit" mode applies it without asking;
// delete still waits for a confirm unless the mode is "auto-all".

async function readMaybe(target) {
  try {
    return { text: await fs.readFile(target, 'utf-8'), existed: true };
  } catch {
    return { text: '', existed: false };
  }
}

const WRITE_REGISTRY = [
  {
    name: 'write_file',
    label: 'write',
    autoInEditMode: true,
    description:
      'Create a new file or overwrite an existing one with the given content. Missing parent directories are created. Prefer edit_file for a small change to a large file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The full new content of the file.' },
      },
      required: ['path', 'content'],
    },
    async prepare(args) {
      if (!args.path) return { error: 'a file path is required' };
      if (typeof args.content !== 'string') return { error: 'content must be a string' };
      const config = await loadConfig();
      let target;
      try { target = safeResolve(config, args.path); } catch (e) { return { error: e.message }; }
      const { text: old, existed } = await readMaybe(target);
      if (existed && old === args.content) return { error: `"${args.path}" already has exactly that content` };
      const diff = unifiedDiff(old, args.content);
      const { add, del } = diffStat(diff);
      return {
        summary: `${existed ? 'Overwrite' : 'Create'} \`${args.path}\``,
        stat: existed ? `+${add} -${del}` : `${args.content.split('\n').length} lines`,
        diff,
        payload: { path: args.path, content: args.content },
      };
    },
    async execute({ path: relPath, content }) {
      const config = await loadConfig();
      const target = safeResolve(config, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      return { ok: true, applied: true, detail: `${relPath} was written (${content.split('\n').length} lines).` };
    },
  },
  {
    name: 'append_file',
    label: 'append',
    autoInEditMode: true,
    description:
      'Add text to the end of a file (the file is created if it does not exist). Use this to add a line to a notes/log file — do not use edit_file for that. A newline is inserted before your text if the file does not already end with one.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        text: { type: 'string', description: 'The text to add at the end of the file.' },
      },
      required: ['path', 'text'],
    },
    async prepare(args) {
      if (!args.path) return { error: 'a file path is required' };
      if (typeof args.text !== 'string' || !args.text) return { error: 'text to append is required' };
      const config = await loadConfig();
      let target;
      try { target = safeResolve(config, args.path); } catch (e) { return { error: e.message }; }
      const { text: old, existed } = await readMaybe(target);
      const sep = !old || old.endsWith('\n') ? '' : '\n';
      const next = old + sep + (args.text.endsWith('\n') ? args.text : args.text + '\n');
      const diff = unifiedDiff(old, next);
      const { add } = diffStat(diff);
      return {
        summary: `${existed ? 'Append to' : 'Create'} \`${args.path}\``,
        stat: `+${add}`,
        diff,
        payload: { path: args.path, content: next },
      };
    },
    async execute({ path: relPath, content }) {
      const config = await loadConfig();
      const target = safeResolve(config, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      return { ok: true, applied: true, detail: `text added to the end of ${relPath}.` };
    },
  },
  {
    name: 'edit_file',
    label: 'edit',
    autoInEditMode: true,
    description:
      'Replace an exact substring in a file. old_string must match exactly (whitespace included) and appear once, unless replace_all is true. Use this for targeted changes; use write_file to create or fully replace a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The text to replace it with.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async prepare(args) {
      if (!args.path) return { error: 'a file path is required' };
      if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
        return { error: 'old_string and new_string are both required' };
      }
      // An empty old_string matches between every character — replace_all then
      // splices new_string across the whole file. Never a valid edit; a weak
      // model reaches for it when it means "append". Point it at append_file.
      if (args.old_string === '') {
        return { error: 'old_string is empty — to add text to a file use append_file, or write_file for a full rewrite' };
      }
      if (args.old_string === args.new_string) return { error: 'old_string and new_string are identical' };
      const config = await loadConfig();
      let target;
      try { target = safeResolve(config, args.path); } catch (e) { return { error: e.message }; }
      let old;
      try { old = await fs.readFile(target, 'utf-8'); } catch { return { error: `no file at "${args.path}"` }; }
      const count = old.split(args.old_string).length - 1;
      if (count === 0) return { error: `old_string was not found in "${args.path}"` };
      if (count > 1 && !args.replace_all) {
        return { error: `old_string appears ${count} times in "${args.path}" — make it more specific or pass replace_all` };
      }
      const next = args.replace_all
        ? old.split(args.old_string).join(args.new_string)
        : old.replace(args.old_string, args.new_string);
      const diff = unifiedDiff(old, next);
      const { add, del } = diffStat(diff);
      return {
        summary: `Edit \`${args.path}\`${count > 1 ? ` (×${count})` : ''}`,
        stat: `+${add} -${del}`,
        diff,
        payload: {
          path: args.path,
          old_string: args.old_string,
          new_string: args.new_string,
          replace_all: !!args.replace_all,
        },
      };
    },
    async execute({ path: relPath, old_string, new_string, replace_all }) {
      const config = await loadConfig();
      const target = safeResolve(config, relPath);
      const old = await fs.readFile(target, 'utf-8');
      if (!old.includes(old_string)) throw new Error('the file changed since this was proposed — old_string is no longer present');
      const next = replace_all ? old.split(old_string).join(new_string) : old.replace(old_string, new_string);
      await fs.writeFile(target, next, 'utf-8');
      return { ok: true, applied: true, detail: `${relPath} was edited — the replacement is now saved on disk.` };
    },
  },
  {
    name: 'create_dir',
    label: 'mkdir',
    autoInEditMode: true,
    description: 'Create a new directory (with any missing parents) in the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the workspace root.' } },
      required: ['path'],
    },
    async prepare(args) {
      if (!args.path) return { error: 'a directory path is required' };
      const config = await loadConfig();
      let target;
      try { target = safeResolve(config, args.path); } catch (e) { return { error: e.message }; }
      try {
        const st = await fs.stat(target);
        return { error: st.isDirectory() ? `"${args.path}" already exists` : `"${args.path}" exists as a file` };
      } catch {
        // doesn't exist — good
      }
      return { summary: `Create directory \`${args.path}\``, payload: { path: args.path } };
    },
    async execute({ path: relPath }) {
      const config = await loadConfig();
      await fs.mkdir(safeResolve(config, relPath), { recursive: true });
      return { ok: true, applied: true, detail: `directory ${relPath}/ was created.` };
    },
  },
  {
    name: 'delete_path',
    label: 'delete',
    autoInEditMode: false, // destructive — confirm unless the mode is "auto-all"
    description: 'Delete a file, or an empty directory, from the workspace. A non-empty directory is not deleted.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
      required: ['path'],
    },
    async prepare(args) {
      if (!args.path) return { error: 'a path is required' };
      const config = await loadConfig();
      let target;
      try { target = safeResolve(config, args.path); } catch (e) { return { error: e.message }; }
      let st;
      try { st = await fs.stat(target); } catch { return { error: `nothing at "${args.path}"` }; }
      if (st.isDirectory()) {
        const entries = await fs.readdir(target);
        if (entries.length) return { error: `"${args.path}" is not empty (${entries.length} items) — delete its contents first` };
        return { summary: `Delete empty directory \`${args.path}\``, payload: { path: args.path, isDir: true } };
      }
      let preview = '';
      try {
        const buf = await fs.readFile(target);
        if (!looksBinary(buf)) preview = buf.toString('utf-8').slice(0, 4000);
      } catch {
        // unreadable — still deletable
      }
      return {
        summary: `Delete \`${args.path}\` (${formatSize(st.size)})`,
        diff: preview ? unifiedDiff(preview, '') : null,
        payload: { path: args.path, isDir: false },
      };
    },
    async execute({ path: relPath, isDir }) {
      const config = await loadConfig();
      const target = safeResolve(config, relPath);
      if (isDir) await fs.rmdir(target);
      else await fs.unlink(target);
      return { ok: true, applied: true, detail: `${relPath} was deleted.` };
    },
  },
  {
    // "Write" is shorthand here for "mutating / approval-gated". run_command
    // isn't a write, but it goes through the same prepare/execute + approval
    // machinery, and — like delete_path — is only auto-run in "auto-all".
    // It's also hidden entirely unless config.code.allowCommands is on (see
    // getCodeToolDefinitions); prepare() double-checks that.
    name: 'run_command',
    label: 'run',
    autoInEditMode: false,
    description:
      'Run a shell command with the workspace as its working directory. Normally it waits and returns the output and exit code. Set background:true for a long-running process (a dev server, a watcher) — it returns a bgId immediately and keeps running past this turn; use check_command to read its output and stop_command to end it. One command per call.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run, e.g. "npm test" or "npm run dev".' },
        cwd: { type: 'string', description: 'Optional working directory relative to the workspace root. Default: the root.' },
        background: { type: 'boolean', description: 'Run detached and return a bgId instead of waiting. For servers / watchers only.' },
      },
      required: ['command'],
    },
    async prepare(args) {
      const command = String(args.command || '').trim();
      if (!command) return { error: 'a command is required' };
      const config = await loadConfig();
      if (!config.code?.allowCommands) {
        return { error: 'running commands is turned off — enable it in Settings → Code' };
      }
      let cwdRel = '';
      if (args.cwd) {
        try {
          safeResolve(config, args.cwd);
          cwdRel = String(args.cwd).replace(/^[./]+|\/+$/g, '');
        } catch (e) {
          return { error: e.message };
        }
      }
      const background = !!args.background;
      return {
        summary: `${background ? 'Start (background)' : 'Run'} \`${command}\`${cwdRel ? ` in ${cwdRel}/` : ''}`,
        payload: { command, cwdRel, background },
      };
    },
    async execute({ command, cwdRel, background }, { sessionId } = {}) {
      const config = await loadConfig();
      if (background) {
        const r = await startBackground(config, { sessionId, command, cwdRel });
        if (r.error) return { error: r.error };
        return {
          background: true,
          bgId: r.bgId,
          detail: `started in the background as ${r.bgId}`,
          note: `The command is running detached. It will keep running after this turn. Use check_command("${r.bgId}") to read its output, stop_command("${r.bgId}") to end it.`,
        };
      }
      const res = await runInWorkspace(config, command, { cwdRel });
      const output =
        [res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`].filter(Boolean).join('\n\n') || '(no output)';
      return {
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        output,
        detail: res.timedOut
          ? `timed out after ${Math.round(commandTimeoutMs(config) / 1000)}s`
          : `exit code ${res.exitCode}`,
      };
    },
  },
  {
    // Generate an image with ComfyUI and save it into the workspace. Like
    // run_command it's approval-gated machinery rather than a "write", and
    // hidden entirely unless config.comfy.enabled (see getCodeToolDefinitions).
    // autoInEditMode: true — Vi's call, the agent generates freely in
    // auto-edit; the per-turn count cap (config.comfy.maxPerTurn) is enforced
    // in codeAgent.js#handleWrite.
    name: 'generate_image',
    label: 'image',
    autoInEditMode: true,
    description:
      'Generate an image with ComfyUI and save it into the workspace. Use for placeholder art, textures, sprites, icons, backgrounds. Describe the image plainly in `prompt`; give a workspace `path` like "assets/crate.png".',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A plain description of the image to generate.' },
        path: { type: 'string', description: 'Where to save it, relative to the workspace, e.g. "assets/crate.png". ".png" is added if missing.' },
        negative_prompt: { type: 'string', description: 'What to avoid (optional — a sensible default is used otherwise).' },
        width: { type: 'number', description: 'Width in pixels (optional; defaults from Settings).' },
        height: { type: 'number', description: 'Height in pixels (optional; defaults from Settings).' },
        seed: { type: 'number', description: 'Fix the seed for a reproducible result (optional; random otherwise).' },
        count: { type: 'number', description: 'How many variations (1-4, default 1). After the first, files get a "-2", "-3" suffix.' },
      },
      required: ['prompt', 'path'],
    },
    async prepare(args) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { error: 'describe the image in "prompt"' };
      if (!args.path || typeof args.path !== 'string') return { error: 'a workspace "path" to save the image is required' };

      const config = await loadConfig();
      const comfy = config.comfy;
      if (!comfy?.enabled) return { error: 'image generation is turned off — enable it in Settings → ComfyUI' };
      try {
        buildWorkflow(comfy, { prompt }); // validates the workflow + mapping
      } catch (e) {
        return { error: e.message };
      }

      const count = Math.max(1, Math.min(4, Math.round(args.count) || 1));

      // A bare filename lands in comfy.outputDir when one is set; a path with
      // a slash is taken as given. Add .png if there's no image extension.
      let rel = args.path.trim().replace(/^[/\\]+/, '');
      if (comfy.outputDir && !/[/\\]/.test(rel)) rel = `${comfy.outputDir}/${rel}`;
      if (!/\.(png|jpe?g|webp)$/i.test(rel)) rel += '.png';
      const dot = rel.lastIndexOf('.');
      const stem = rel.slice(0, dot);
      const ext = rel.slice(dot);
      const paths = [rel, ...Array.from({ length: count - 1 }, (_, i) => `${stem}-${i + 2}${ext}`)];
      for (const p of paths) {
        try { safeResolve(config, p); } catch (e) { return { error: e.message }; }
      }

      const w = args.width || comfy.defaultWidth || 512;
      const h = args.height || comfy.defaultHeight || 512;
      return {
        summary: `Generate image${count > 1 ? ` ×${count}` : ''} → \`${paths[0]}\` (${w}×${h})`,
        payload: {
          prompt,
          negative: typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined,
          width: args.width || undefined,
          height: args.height || undefined,
          seed: Number.isFinite(+args.seed) ? Math.round(+args.seed) : undefined,
          count,
          paths,
        },
      };
    },
    async execute({ prompt, negative, width, height, seed, count, paths }, { signal, onProgress } = {}) {
      const config = await loadConfig();
      const { images, meta } = await comfyGenerate(
        config.comfy,
        { prompt, negative, width, height, seed, count },
        { signal, onProgress }
      );
      const written = [];
      for (let i = 0; i < images.length && i < paths.length; i++) {
        const rel = await writeBinaryFile(config, paths[i], images[i].buffer);
        written.push({ path: rel, bytes: images[i].buffer.length, seed: images[i].seed });
      }
      if (!written.length) return { error: 'ComfyUI ran but returned no image' };
      const seeds = [...new Set(written.map((w) => w.seed))].join(', ');
      return {
        ok: true,
        applied: true,
        images: written,
        detail: `${written.length} image${written.length === 1 ? '' : 's'} saved: ${written
          .map((w) => w.path)
          .join(', ')} — ${meta.width}×${meta.height}, seed ${seeds}`,
      };
    },
  },
];

const WRITE_BY_NAME = new Map(WRITE_REGISTRY.map((t) => [t.name, t]));

// ask_user is neither a read nor a write tool: it has no handler here.
// codeAgent.js intercepts the call, posts a question card, and suspends the
// turn until the user answers (the same machinery as a held write). Defined
// here only so it's in the tool list the model sees and in codeToolNames()
// (so recoverToolCalls can repair a fumbled one).
// update_tasks (Code parity roadmap 1a): like ask_user, no handler here —
// codeAgent.js intercepts the call and writes session.tasks. Whole-list
// replace on every call is the simplest contract for a weak model to keep
// right. Withheld in plan mode (the plan-mode reply *is* the plan).
export const UPDATE_TASKS_TOOL = {
  name: 'update_tasks',
  label: 'tasks',
  description:
    'Record or update your task list for the work you are doing. Call it once near the start with your planned steps, then again whenever a step finishes or the plan changes — always pass the COMPLETE list (it replaces the previous one). Keep each task a short imperative line. Skip it entirely for a one- or two-step request.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The complete task list, in order.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'A short imperative description of the step.' },
            status: {
              type: 'string',
              enum: ['pending', 'active', 'done'],
              description: 'pending = not started, active = doing it now, done = finished.',
            },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['tasks'],
  },
};

export const ASK_USER_TOOL = {
  name: 'ask_user',
  label: 'ask',
  description:
    'Ask the user a question and wait for their answer. Use this — instead of guessing — when a choice is genuinely theirs to make: an ambiguous requirement, a fork in the design, or whether to do something destructive or far-reaching. Do NOT use it for anything you can work out from the code or the conversation so far.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional suggested answers, shown as buttons. The user can still type their own answer.',
      },
    },
    required: ['question'],
  },
};

const toDefinition = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

// Tools the user is allowed to switch off in Settings → Code (Code parity
// 2a). The four core reads aren't here — the agent is useless without them.
export const OPTIONAL_TOOL_INFO = [
  { name: 'search_text', label: 'search file contents' },
  { name: 'find_files', label: 'find files by name' },
  { name: 'append_file', label: 'append to a file' },
  { name: 'run_command', label: 'run a shell command' },
  { name: 'check_command', label: 'check a background command' },
  { name: 'stop_command', label: 'stop a background command' },
  { name: 'run_checks', label: 'run the configured checks' },
  { name: 'generate_image', label: 'generate an image (ComfyUI)' },
  { name: 'update_tasks', label: 'keep a task list' },
  { name: 'ask_user', label: 'ask the user a question' },
];
const OPTIONAL_NAMES = new Set(OPTIONAL_TOOL_INFO.map((t) => t.name));

// A tool the model can't see is a tool it can't call. Hidden when its
// feature is off (run_command / generate_image / run_checks), when the user
// switched it off (disabledTools), or — check_command / stop_command — when
// there's no background command to act on yet. In plan mode every write tool
// is withheld: the agent can only look.
export function getCodeToolDefinitions({
  allowCommands = false,
  comfyEnabled = false,
  checksConfigured = false,
  planMode = false,
  hasBackgroundCommands = false,
  disabledTools = [],
} = {}) {
  const hidden = new Set(Array.isArray(disabledTools) ? disabledTools.filter((n) => OPTIONAL_NAMES.has(n)) : []);
  if (!allowCommands) { hidden.add('run_command'); hidden.add('check_command'); hidden.add('stop_command'); }
  if (allowCommands && !hasBackgroundCommands) { hidden.add('check_command'); hidden.add('stop_command'); }
  if (!comfyEnabled) hidden.add('generate_image');
  if (!checksConfigured) hidden.add('run_checks');

  const read = REGISTRY.filter((t) => !hidden.has(t.name));
  const write = planMode ? [] : WRITE_REGISTRY.filter((t) => !hidden.has(t.name));
  const extras = [];
  if (!planMode && !hidden.has('update_tasks')) extras.push(UPDATE_TASKS_TOOL);
  if (!hidden.has('ask_user')) extras.push(ASK_USER_TOOL);
  return [...read, ...write, ...extras].map(toDefinition);
}

export function codeToolNames() {
  return new Set([...BY_NAME.keys(), ...WRITE_BY_NAME.keys(), 'ask_user', 'update_tasks']);
}

export function codeToolLabel(name) {
  if (name === 'ask_user') return ASK_USER_TOOL.label;
  if (name === 'update_tasks') return UPDATE_TASKS_TOOL.label;
  return (BY_NAME.get(name) || WRITE_BY_NAME.get(name))?.label || name;
}

export function isWriteTool(name) {
  return WRITE_BY_NAME.has(name);
}

export function writeToolAutoInEditMode(name) {
  return !!WRITE_BY_NAME.get(name)?.autoInEditMode;
}

// codeAgent.js: validate + build a diff for review. Returns { error } or
// { summary, stat?, diff?, payload }.
export async function prepareWriteTool(name, rawArgs) {
  const tool = WRITE_BY_NAME.get(name);
  const args = parseArgs(rawArgs);
  console.log(`[code] prepare ${name}`, JSON.stringify(args).slice(0, 300));
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.prepare(args);
  } catch (err) {
    return { error: err.message };
  }
}

// codeAgent.js: run it, once approved (or auto-approved). `opts` carries the
// turn's AbortController signal (and, for generate_image, an onProgress
// callback) — write tools that don't need them just ignore the second arg.
export async function executeWriteTool(name, payload, opts = {}) {
  const tool = WRITE_BY_NAME.get(name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.execute(payload, opts);
  } catch (err) {
    return { error: err.message };
  }
}

export async function executeCodeTool(name, rawArgs) {
  const tool = BY_NAME.get(name);
  const args = parseArgs(rawArgs);
  console.log(`[code] tool: ${name}`, JSON.stringify(args));
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.handler(args);
  } catch (err) {
    return { error: err.message };
  }
}

export { parseArgs };
