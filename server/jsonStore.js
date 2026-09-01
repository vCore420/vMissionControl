// Crash-safe JSON file writes.
//
// The persisted stores in this app — config.js, codeStore.js, timesheet.js,
// profiles.js — each already serialise their writes through a queue so
// concurrent callers can't interleave. What they didn't have is atomicity per
// write: a bare fs.writeFile that's interrupted (process killed, power lost)
// mid-write leaves a truncated file. For config.json that's unrecoverable on
// the next boot — ensureConfigExists() sees the file present and won't reseed
// it, and JSON.parse throws.
//
// This writes to a uniquely-named temp file in the same directory, flushes it,
// then renames it over the target. rename() replaces atomically on a single
// volume (POSIX and NTFS both), so a reader — or the next startup — only ever
// sees the old file intact or the whole new one, never a partial.
//
// Windows wrinkle: rename onto an existing file fails with EPERM/EACCES when
// anything else holds even a transient handle to the target (an AV scanner,
// the search indexer, a concurrent reader). It clears in milliseconds, so the
// rename is retried a few times before giving up — the same approach npm's own
// write-file-atomic takes. A write that still fails leaves the previous file
// untouched.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const RENAME_RETRIES = 10;
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  const json = JSON.stringify(data, null, 2);

  let handle;
  try {
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(json, 'utf-8');
    // Durability against power loss, not just a killed process. Best-effort:
    // the atomicity guarantee is the rename below, which holds even if the
    // platform refuses the fsync.
    try {
      await handle.sync();
    } catch {
      /* fsync unsupported / transient — the rename still can't tear the file */
    }
  } finally {
    await handle?.close();
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRIES || !RETRYABLE.has(err.code)) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(10 * (attempt + 1));
    }
  }
}
