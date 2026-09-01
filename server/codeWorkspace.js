// The Code tab's sandbox — one directory on the host the coding agent is
// allowed to see and modify. Everything the agent touches goes through
// safeResolve() here, exactly like the shared-folder browser does in
// routes/files.js: a client-supplied relative path is resolved against the
// workspace root and anything that would escape it is rejected.
//
// This module owns path resolution, the read-only listing/read the Code
// view's workspace panel uses, and the source-of-truth file (Phase 7).
// The agent's own read/write/run tools live in codeTools.js / codeExec.js
// and build on the same root + safeResolve.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSharedFolderPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class WorkspacePathError extends Error {}

// Where the agent works. An explicit config.code.workspacePath wins (absolute
// used as-is, relative resolved against the project root — same convention as
// config.js#resolveSharedFolderPath). Otherwise: a `code` subfolder of the
// shared folder when sharing is on (so the existing Files tab is already a
// window into it), else a standalone `workspace` folder in the project root.
export function resolveWorkspacePath(config) {
  const explicit = (config.code?.workspacePath || '').trim();
  let p;
  if (explicit) p = path.isAbsolute(explicit) ? explicit : path.join(__dirname, '..', explicit);
  else if (config.sharedFolder?.enabled) p = path.join(resolveSharedFolderPath(config), 'code');
  else p = path.join(__dirname, '..', 'workspace');
  // Normalise separators + `.`/`..` so string comparisons in safeResolve are
  // reliable regardless of how the path was typed in settings.
  return path.resolve(p);
}

export async function ensureWorkspace(config) {
  const root = resolveWorkspacePath(config);
  await fs.mkdir(root, { recursive: true });
  return root;
}

// Resolve a client-supplied path against the workspace root and reject
// anything that lands outside it. Based on routes/files.js#safeResolve — its
// own copy for now (a shared helper is a later cleanup) — but more forgiving
// of the model's input: a leading slash is treated as root-relative, and an
// absolute path that happens to sit inside the workspace is rebased rather
// than rejected (small models pass the absolute path from the prompt even
// when told to use a relative one).
export function safeResolve(config, relPath) {
  const root = resolveWorkspacePath(config);
  let p = String(relPath || '').trim().replace(/^[/\\]+/, ''); // leading slash -> root-relative

  if (path.isAbsolute(p) || /^[a-zA-Z]:[/\\]/.test(p)) {
    const rel = path.relative(root, p);
    if (rel === '') return root;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WorkspacePathError('that path is outside the workspace — use a path relative to the workspace root');
    }
    p = rel;
  }

  const target = path.resolve(root, '.' + path.sep + p);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new WorkspacePathError('path escapes the workspace');
  }
  return target;
}

// One directory listing, dirs first then files, each alphabetical — same
// ordering as the shared-folder browser so the two panels read the same way.
export async function listDir(config, relPath) {
  await ensureWorkspace(config);
  const target = safeResolve(config, relPath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const stat = await fs.stat(path.join(target, entry.name)).catch(() => null);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat?.size ?? null,
        modified: stat?.mtime ?? null,
      };
    })
  );
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: relPath || '', items };
}

const DEFAULT_MAX_BYTES = 256 * 1024;

// Read a workspace file as text for the Phase-1 viewer. Capped so opening a
// huge file in the panel can't stall the response; the agent's own read_file
// tool (Phase 2) gets its own, purpose-built limits.
export async function readFile(config, relPath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  await ensureWorkspace(config);
  const target = safeResolve(config, relPath);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new WorkspacePathError('that path is a directory');
  const buf = await fs.readFile(target);
  const truncated = buf.length > maxBytes;
  return {
    path: relPath,
    size: stat.size,
    truncated,
    text: buf.subarray(0, maxBytes).toString('utf-8'),
  };
}

// Write raw bytes to a workspace-relative path (creating parent folders).
// The one non-text write path — the Code agent's text tools all go through
// fs.writeFile(..., 'utf-8'); this is for generate_image's PNGs. Same
// safeResolve guard as everything else here. Returns the workspace-relative
// path actually written (normalised forward slashes).
export async function writeBinaryFile(config, relPath, buffer) {
  await ensureWorkspace(config);
  const root = resolveWorkspacePath(config);
  const target = safeResolve(config, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return path.relative(root, target).replace(/\\/g, '/');
}

// ---------- Workspace docs read into the prompt ----------
//
// Two files the agent gets at the start of every turn (codeAgent.js):
//   - the source-of-truth file (config.code.contextFileName, default AGENTS.md)
//     — Phase 7, the CLAUDE.md / AGENTS.md idea, human-authored + authoritative;
//   - the memory file (config.code.memoryFileName, default AGENTS-memory.md) —
//     Phase 8, the agent's own running notes, agent-written + human-curated.
// Both are capped hard: a 16 KB file is already ~4k tokens of a 16k window,
// so anything past that is dropped and the agent is told it was truncated.

export const WORKSPACE_DOC_MAX_BYTES = 16 * 1024;

// A configured name → its normalised workspace-relative path (forward slashes,
// no leading ./ or /), or '' when the name is blank (feature off).
function docRel(name) {
  const n = (name || '').trim();
  return n ? n.replace(/^[./\\]+/, '').replace(/\\/g, '/') : '';
}

export const contextFileRel = (config) => docRel(config.code?.contextFileName);
export const memoryFileRel = (config) => docRel(config.code?.memoryFileName);

// { name, exists, content, bytes, truncated } — or null when no name is set.
// Never throws: a missing file, a directory, or a path that escapes the
// workspace all come back as exists:false so a turn still runs.
async function readWorkspaceDoc(config, name) {
  const rel = docRel(name);
  if (!rel) return null;
  const clean = (name || '').trim();
  const miss = { name: clean, exists: false, content: '', bytes: 0, truncated: false };
  let target;
  try {
    target = safeResolve(config, rel);
  } catch {
    return miss;
  }
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return miss;
    const buf = await fs.readFile(target);
    return {
      name: clean,
      exists: true,
      content: buf.subarray(0, WORKSPACE_DOC_MAX_BYTES).toString('utf-8'),
      bytes: buf.length,
      truncated: buf.length > WORKSPACE_DOC_MAX_BYTES,
    };
  } catch {
    return miss;
  }
}

export const readContextFile = (config) => readWorkspaceDoc(config, config.code?.contextFileName);
export const readMemoryFile = (config) => readWorkspaceDoc(config, config.code?.memoryFileName);

function contextFileTemplate(name) {
  const title = name.replace(/\.md$/i, '');
  return (
    `# ${title}\n\n` +
    `The source-of-truth file for this project. The coding agent reads it at\n` +
    `the start of every turn and treats it as authoritative — so keep it\n` +
    `short and current.\n\n` +
    `## What this project is\n\n` +
    `<a sentence or two: what it does, the stack, how it runs>\n\n` +
    `## Conventions\n\n` +
    `- <naming, structure, patterns to follow>\n\n` +
    `## Good to know\n\n` +
    `- <gotchas, non-obvious wiring, where things live>\n\n` +
    `## Don't\n\n` +
    `- <things that look reasonable but break something>\n`
  );
}

function memoryFileTemplate(name) {
  const title = name.replace(/\.md$/i, '');
  return (
    `# ${title}\n\n` +
    `The coding agent's running notes for this project — it appends a line\n` +
    `here when it learns something worth carrying into the next turn. Safe to\n` +
    `edit or prune by hand.\n\n` +
    `## Notes\n`
  );
}

// Create the source-of-truth file from a starter template. Refuses if it
// already exists (this is the "you don't have one yet — make one" button,
// not a reset). Returns { created, rel }.
export async function createContextFile(config) {
  const rel = contextFileRel(config);
  if (!rel) throw new WorkspacePathError('no source-of-truth file name is set (Settings → Code)');
  return writeDocIfMissing(config, rel, contextFileTemplate((config.code.contextFileName || 'AGENTS.md').trim()));
}

// Ensure the memory file exists — called from codeAgent.js before a turn when
// the feature is on, so the agent always has something to append to. Unlike
// the source-of-truth file the agent owns this one, so it's created silently
// rather than offered as a button.
export async function ensureMemoryFile(config) {
  const rel = memoryFileRel(config);
  if (!rel) return { created: false, rel: '' };
  return writeDocIfMissing(config, rel, memoryFileTemplate((config.code.memoryFileName || 'AGENTS-memory.md').trim()));
}

async function writeDocIfMissing(config, rel, contents) {
  await ensureWorkspace(config);
  const target = safeResolve(config, rel);
  try {
    await fs.stat(target);
    return { created: false, rel }; // already there — leave it alone
  } catch {
    // doesn't exist — good
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf-8');
  return { created: true, rel };
}

// Append a block to the memory file (used by "Save plan → memory" — Phase 3).
// Creates the file from its template first if it's missing. Throws
// WorkspacePathError if the memory-file feature is off. Returns { rel, bytes }.
export async function appendToMemoryFile(config, block) {
  const rel = memoryFileRel(config);
  if (!rel) throw new WorkspacePathError('no memory file is set — configure one in Settings → Code first');
  await ensureMemoryFile(config);
  const target = safeResolve(config, rel);
  const existing = await fs.readFile(target, 'utf-8').catch(() => '');
  const sep = !existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const next = existing + sep + block.trim() + '\n';
  await fs.writeFile(target, next, 'utf-8');
  return { rel, bytes: Buffer.byteLength(next, 'utf-8') };
}

export { WorkspacePathError };
