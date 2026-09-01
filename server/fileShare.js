// Shared-folder helpers that need to be reachable from more than one place:
// routes/files.js (the browser-facing endpoints) and ollamaTools.js (the
// assistant's search_shared_folder / get_recent_uploads tools). The route
// module still owns everything HTTP — path resolution, permissions, the
// upload middleware — this is only the recursive filename search and the
// in-memory "recently uploaded" list, which both surfaces want verbatim.

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSharedFolderPath } from './config.js';

// Capped two ways: SEARCH_MAX_RESULTS keeps the response bounded,
// SEARCH_MAX_SCANNED keeps a huge/deep tree from tying up the event loop
// on one request. Hitting either returns whatever's found so far with a
// `truncated` flag rather than making the caller wait for a scan that may
// never finish.
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_SCANNED = 20000;

async function searchDir(root, relDir, query, results, scanned) {
  if (results.length >= SEARCH_MAX_RESULTS || scanned.count >= SEARCH_MAX_SCANNED) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= SEARCH_MAX_RESULTS || scanned.count >= SEARCH_MAX_SCANNED) return;
    scanned.count += 1;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.name.toLowerCase().includes(query)) {
      const stat = await fs.stat(path.join(root, relPath)).catch(() => null);
      results.push({
        path: relPath,
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat?.size ?? null,
        modified: stat?.mtime ?? null,
      });
    }
    if (entry.isDirectory()) {
      await searchDir(root, relPath, query, results, scanned);
    }
  }
}

// Recursive, case-insensitive filename search across the whole shared tree.
export async function searchSharedFolder(config, rawQuery) {
  const query = (rawQuery || '').trim().toLowerCase();
  if (!query) return { items: [], truncated: false };
  const root = resolveSharedFolderPath(config);
  const results = [];
  const scanned = { count: 0 };
  await searchDir(root, '', query, results, scanned);
  return {
    items: results,
    truncated: results.length >= SEARCH_MAX_RESULTS || scanned.count >= SEARCH_MAX_SCANNED,
  };
}

// Last N uploads, newest first — in-memory only, same ephemeral choice as
// chat history / device tracking / host stats. Backs the "Recently added"
// panel and the assistant's get_recent_uploads tool.
const MAX_RECENT = 30;
const recentUploads = [];

export function recordUpload(relPath, name, size) {
  recentUploads.unshift({ path: relPath, name, size, uploadedAt: new Date().toISOString() });
  recentUploads.length = Math.min(recentUploads.length, MAX_RECENT);
}

export function getRecentUploads() {
  return recentUploads;
}
