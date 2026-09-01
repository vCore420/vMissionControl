// `@file` mentions for a Code message (Code parity roadmap 3a).
//
// The composer's `@` picker stages workspace-relative paths; they arrive on
// the send as `mentions: ["src/app.js", ...]`. This reads each one and splices
// its current contents onto the turn's user message — the same "context for
// this turn only" idea as codeAttach.js, except the source is a file already
// in the workspace (so it's read server-side, not sent inline).
//
// Only lightweight metadata is stored on the message (for the transcript's
// clickable chip); the text reaches the model for the triggering turn only.
// Next turn it's gone — the agent has read_file.

import { readFile as readWorkspaceFile } from './codeWorkspace.js';
import { looksBinary } from './textFiles.js';

const MAX_MENTIONS = 8;
const PER_FILE_BYTES = 24_000; // ~6k tokens — matches codeAttach.js's per-file cap

// paths: string[] from the POST body.
// → { stored: [{ path, bytes, truncated, missing }], forPrompt: [{ path, text?, note?, truncated? }] }
export async function processMentions(config, paths) {
  if (!Array.isArray(paths) || !paths.length) return { stored: [], forPrompt: [] };

  const seen = new Set();
  const stored = [];
  const forPrompt = [];

  for (const raw of paths.slice(0, MAX_MENTIONS)) {
    const path = String(raw || '').replace(/[\r\n\t]/g, '').trim().replace(/^[/\\]+/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);

    let file;
    try {
      file = await readWorkspaceFile(config, path, { maxBytes: PER_FILE_BYTES });
    } catch {
      stored.push({ path, bytes: 0, truncated: false, missing: true });
      forPrompt.push({ path, note: 'referenced with @ but not found in the workspace' });
      continue;
    }

    if (looksBinary(Buffer.from(file.text.slice(0, 2048), 'utf-8'))) {
      stored.push({ path, bytes: file.size, truncated: false, missing: false, binary: true });
      forPrompt.push({ path, note: 'referenced with @ but looks binary — not shown' });
      continue;
    }

    stored.push({ path, bytes: file.size, truncated: file.truncated, missing: false });
    forPrompt.push({ path, text: file.text, truncated: file.truncated });
  }

  return { stored, forPrompt };
}

// Appended to the triggering user message's content for the turn.
export function mentionBlock(forPrompt) {
  if (!forPrompt?.length) return '';
  return forPrompt
    .map((m) =>
      m.note
        ? `\n\n[workspace file: ${m.path} — ${m.note}]`
        : `\n\n[workspace file: ${m.path}${m.truncated ? ' — shown truncated; read_file for the rest' : ''}]\n\`\`\`\n${m.text}\n\`\`\``
    )
    .join('');
}
