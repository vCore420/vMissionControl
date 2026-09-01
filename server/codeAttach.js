// Code tab message attachments (Phase 9).
//
// The user can attach text files to a Code message; their contents are
// spliced onto that one turn's message so the agent sees them in place —
// the same idea as chat.js#readAttachmentAsContext, but the text arrives
// inline in the JSON POST (no upload / disk store) because a Code attachment
// is context for a turn, not a file to keep and re-serve.
//
// The attachment is NOT persisted with its content: only lightweight
// metadata goes on the stored message (for the transcript chip), and the
// text reaches the model for the triggering turn only. Next turn it's gone —
// the agent has read_file for anything in the workspace.

import { isTextByName, looksBinary } from './textFiles.js';

const MAX_ATTACHMENTS = 5;
const PER_FILE_CHARS = 24000; // ~6k tokens — generous for a real source file, still bounded
const MAX_RAW_CHARS = 400_000; // reject an obviously-too-big paste before we even look at it

// raw: [{ name, content }] from the POST body.
// → { stored: [{ name, bytes, truncated, skipped }], forPrompt: [{ name, text?, note?, truncated? }] }
export function processAttachments(raw) {
  if (!Array.isArray(raw) || !raw.length) return { stored: [], forPrompt: [] };
  const stored = [];
  const forPrompt = [];

  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    const name = String(a?.name || 'file').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'file';
    let content = typeof a?.content === 'string' ? a.content : '';
    if (content.length > MAX_RAW_CHARS) content = content.slice(0, MAX_RAW_CHARS);
    const bytes = Buffer.byteLength(content, 'utf-8');

    const unreadable =
      !content ||
      !isTextByName(name) ||
      content.includes(String.fromCharCode(0)) || // a real text file never has a NUL
      looksBinary(Buffer.from(content.slice(0, 2048), 'utf-8'));

    if (unreadable) {
      stored.push({ name, bytes, truncated: false, skipped: true });
      forPrompt.push({ name, note: "attached but can't be read as text" });
      continue;
    }

    const truncated = content.length > PER_FILE_CHARS;
    stored.push({ name, bytes, truncated, skipped: false });
    forPrompt.push({ name, text: truncated ? content.slice(0, PER_FILE_CHARS) : content, truncated });
  }

  return { stored, forPrompt };
}

// The block appended to the triggering user message's content for the turn.
export function attachmentBlock(forPrompt) {
  if (!forPrompt?.length) return '';
  return forPrompt
    .map((a) =>
      a.note
        ? `\n\n[attached: ${a.name} — ${a.note}]`
        : `\n\n[attached: ${a.name}${a.truncated ? ' — shown truncated' : ''}]\n\`\`\`\n${a.text}\n\`\`\``
    )
    .join('');
}
