// Shared "is this a text file / does this buffer look binary" helpers.
//
// Extracted from chat.js (attachment → assistant context) once codeAttach.js
// needed the same judgement for the Code tab's message attachments, and
// codeTools.js already had its own byte-for-byte copy of looksBinary. One
// implementation, three callers.

export const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'log', 'json', 'jsonc', 'ndjson',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties',
  'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'diff', 'patch',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'scala', 'clj', 'ex', 'exs',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'pl', 'pm', 'lua', 'r', 'sql',
  'graphql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
]);

export const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'gitignore', 'gitconfig', 'editorconfig', 'npmrc', 'env',
]);

export function isTextByName(name = '') {
  const base = name.toLowerCase().replace(/^\./, '');
  if (TEXT_BASENAMES.has(base)) return true;
  if (name.toLowerCase().startsWith('.env')) return true;
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return TEXT_EXTENSIONS.has(ext);
}

// A file that's "text" by name but full of control bytes is really binary.
export function looksBinary(buf) {
  const sample = buf.subarray(0, 1024);
  if (!sample.length) return false;
  let bad = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13) continue; // tab / LF / CR
    if (b < 32 || b === 127) bad++;
  }
  return bad / sample.length > 0.1;
}
