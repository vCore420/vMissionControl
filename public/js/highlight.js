// A deliberately small syntax highlighter — no dependency, same call as
// markdown.js / server-side ollama.js / auth.js. A real highlighter
// (Prism, highlight.js, Shiki) would dwarf this zero-build project; this
// covers the handful of languages a local coding agent actually touches,
// well enough to read a diff or a file at a glance. It is NOT a parser:
// strings/comments/numbers/keywords by regex, everything else left plain.
//
// Used by markdown.js (fenced code in assistant replies) and code.js (the
// workspace file viewer). Output is HTML-escaped token-by-token, so it is
// safe to inject.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// Each grammar is an ordered list of [class, regex] — earlier rules win, so
// strings and comments come before keywords. Regexes must have NO capturing
// groups (use (?:…)); they're combined into one alternation.
const KW_JS =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|' +
  'super|this|import|export|from|as|default|async|await|yield|try|catch|finally|throw|typeof|' +
  'instanceof|in|of|void|delete|null|undefined|true|false|static|get|set|=>';
const KW_PY =
  'def|class|return|if|elif|else|for|while|break|continue|import|from|as|pass|raise|try|except|' +
  'finally|with|lambda|yield|global|nonlocal|assert|del|not|and|or|is|in|None|True|False|self|async|await';
const KW_SH =
  'if|then|elif|else|fi|for|in|do|done|while|until|case|esac|function|return|export|local|source|' +
  'echo|cd|set|unset|read|exit|trap';

const GRAMMARS = {
  js: [
    ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ['string', /`(?:\\[\s\S]|[^\\`])*`|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'/],
    ['number', /\b0[xXbBoO][0-9a-fA-F]+\b|\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b/],
    ['keyword', new RegExp(`\\b(?:${KW_JS})\\b|=>`)],
    ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
    ['punct', /[{}()[\];,.]|(?:[-+*/%=<>!&|^~?:]+)/],
  ],
  json: [
    ['key', /"(?:\\[\s\S]|[^\\"\n])*"(?=\s*:)/],
    ['string', /"(?:\\[\s\S]|[^\\"\n])*"/],
    ['number', /-?\b\d[\d.eE+-]*\b/],
    ['keyword', /\b(?:true|false|null)\b/],
    ['punct', /[{}[\]:,]/],
  ],
  py: [
    ['comment', /#[^\n]*/],
    ['string', /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'/],
    ['number', /\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b/],
    ['keyword', new RegExp(`\\b(?:${KW_PY})\\b`)],
    ['fn', /\b[A-Za-z_]\w*(?=\s*\()/],
    ['punct', /[{}()[\]:;,.]|(?:[-+*/%=<>!&|^~@]+)/],
  ],
  sh: [
    ['comment', /#[^\n]*/],
    ['string', /"(?:\\[\s\S]|[^\\"])*"|'[^']*'/],
    ['variable', /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[@*#?!$0-9-]/],
    ['keyword', new RegExp(`\\b(?:${KW_SH})\\b`)],
    ['punct', /&&|\|\||>>|[|&;()<>]/],
  ],
  css: [
    ['comment', /\/\*[\s\S]*?\*\//],
    ['string', /"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'/],
    ['selector', /[.#]?-?[A-Za-z_][\w-]*(?=[^{};]*\{)/],
    ['key', /[-A-Za-z]+(?=\s*:)/],
    ['number', /-?\b\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b|#[0-9a-fA-F]{3,8}\b/],
    ['punct', /[{}();:,]/],
  ],
  html: [
    ['comment', /<!--[\s\S]*?-->/],
    ['tag', /<\/?[A-Za-z][\w-]*|\/?>/],
    ['string', /"(?:[^"\n]*)"|'(?:[^'\n]*)'/],
    ['key', /\b[A-Za-z-]+(?==)/],
    ['keyword', /&[a-z]+;|&#\d+;/],
  ],
  yaml: [
    ['comment', /#[^\n]*/],
    ['key', /^[ \t]*[-\w .]+?(?=:\s|:$)/m],
    ['string', /"(?:\\[\s\S]|[^\\"\n])*"|'[^'\n]*'/],
    ['number', /\b-?\d[\d.eE+-]*\b/],
    ['keyword', /\b(?:true|false|null|yes|no|on|off)\b/i],
    ['punct', /[-:|>[\]{},]/],
  ],
  md: [
    ['heading', /^#{1,6} [^\n]*/m],
    ['comment', /^>[^\n]*/m],
    ['string', /`[^`\n]+`|```[\s\S]*?```/],
    ['keyword', /\*\*[^*\n]+\*\*|__[^_\n]+__/],
    ['fn', /^\s*(?:[-*+]|\d+[.)])\s/m],
    ['tag', /\[[^\]]+\]\([^)\s]+\)/],
  ],
  default: [
    ['comment', /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//],
    ['string', /"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'|`(?:\\[\s\S]|[^\\`])*`/],
    ['number', /\b\d[\d_]*\.?\d*\b/],
  ],
};

const ALIAS = {
  javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', mjs: 'js', cjs: 'js',
  node: 'js', 'js/jsx': 'js', es6: 'js',
  jsonc: 'json', json5: 'json',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', shellscript: 'sh', console: 'sh', sh: 'sh',
  scss: 'css', less: 'css',
  htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  yml: 'yaml',
  markdown: 'md', mkd: 'md',
  text: 'default', txt: 'default', plaintext: 'default', '': 'default',
};

function grammarFor(lang) {
  const key = ALIAS[(lang || '').toLowerCase()] ?? (lang || '').toLowerCase();
  return GRAMMARS[key] || GRAMMARS.default;
}

// A file path or extension -> a language key markdown/grammarFor understands.
export function langFromPath(path = '') {
  const base = path.toLowerCase().split(/[/\\]/).pop() || '';
  if (base === 'dockerfile' || base === 'makefile') return 'sh';
  if (base.startsWith('.env') || base === '.gitignore' || base === '.npmrc') return 'sh';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return ext;
}

const cache = new Map();
function combined(grammar) {
  if (cache.has(grammar)) return cache.get(grammar);
  const re = new RegExp(grammar.map(([, r]) => `(${r.source})`).join('|'), 'gm');
  cache.set(grammar, re);
  return re;
}

export function highlight(code, lang) {
  const src = String(code ?? '');
  const grammar = grammarFor(lang);
  const re = combined(grammar);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(src.slice(last, m.index));
    let gi = 1;
    while (gi <= grammar.length && m[gi] == null) gi++;
    const cls = grammar[gi - 1] ? grammar[gi - 1][0] : 'text';
    out += `<span class="tok-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(src.slice(last));
  return out;
}
