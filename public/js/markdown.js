// A deliberately small Markdown -> HTML renderer for the Ollama assistant's
// chat replies. Same "build the small thing rather than pull a dependency"
// call as server/ollama.js and auth.js -- a full parser (marked, markdown-it)
// would be the single biggest thing in this zero-build project's dependency
// tree, for output that only ever needs the subset an LLM actually emits:
// fenced + inline code, bold/italic, links, headings, blockquotes, and
// flat ordered/unordered lists. NOT spec-complete: no tables, no nested
// lists, no reference links, no raw-HTML passthrough.
//
// Safety: every piece of model text is HTML-escaped before any rule runs
// (block structure is detected on the raw line, but text content is only
// ever emitted through esc()/inline()), so nothing the model writes can
// inject markup. Links are restricted to http(s)/mailto and get
// rel="noopener". Fenced code goes through highlight.js, which also escapes
// token-by-token.

import { highlight } from './highlight.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function safeHref(url) {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

// Private-use code points: they don't occur in model text and esc() leaves
// them alone, so they're a safe placeholder for a code span while the
// emphasis/link/url rules run over everything else.
const CODE_OPEN = String.fromCharCode(0xe000);
const CODE_CLOSE = String.fromCharCode(0xe001);
const CODE_RE = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g');

// Inline rules, run on a single raw string. Inline code is pulled out first
// so the emphasis/link/url rules can't reach inside it.
function inline(raw) {
  const codes = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });

  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : whole;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  return s.replace(CODE_RE, (_, n) => `<code>${codes[+n]}</code>`);
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let i = 0;

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      const lang = fence[1] || '';
      out.push(
        `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${highlight(body.join('\n'), lang)}</code></pre>`
      );
      continue;
    }

    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    const heading = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (heading) {
      flushPara();
      const level = Math.min(6, heading[1].length + 2); // '#' -> h3, '####' -> h6: chat bubbles don't want an h1
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
        if (!m) break;
        items.push(`<li>${inline(m[2])}</li>`);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}
