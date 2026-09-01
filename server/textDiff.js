// Minimal line-level diff → unified-diff text, no dependencies. Used to show
// the agent's proposed file writes/edits for review before they apply
// (codeTools.js write tools, codeAgent.js approval steps).
//
// Not trying to be Myers-optimal — a straight LCS over lines, then hunks
// with a few lines of context. Fine for the small files a local coding
// agent touches; a giant file just produces a long diff.

function lcsOps(a, b) {
  const m = a.length;
  const n = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const lcs = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = []; // [' '|'-'|'+', line]
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < m) ops.push(['-', a[i++]]);
  while (j < n) ops.push(['+', b[j++]]);
  return ops;
}

// Group ops into hunks: runs of changes plus `context` unchanged lines on
// each side. Unchanged stretches longer than 2*context between two hunks
// split them apart; a shorter stretch keeps them merged.
function toHunks(ops, context) {
  const changeIdx = ops.map((o, k) => (o[0] === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (!changeIdx.length) return [];
  const hunks = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length, changeIdx[0] + 1 + context);
  for (let c = 1; c < changeIdx.length; c++) {
    const k = changeIdx[c];
    if (k - context <= end) {
      end = Math.min(ops.length, k + 1 + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, k - context);
      end = Math.min(ops.length, k + 1 + context);
    }
  }
  hunks.push([start, end]);
  return hunks;
}

// Returns a unified-diff string (no ---/+++ file header; the caller labels
// it). `oldStr`/`newStr` are whole file contents (use '' for a new file or a
// deletion). An empty string means "no change".
export function unifiedDiff(oldStr, newStr, { context = 3 } = {}) {
  if (oldStr === newStr) return '';
  // Normalise line endings for the *display* only — a CRLF file vs an LF
  // edit shouldn't render every line as a change, and a trailing \r on
  // every line is just noise. The actual write is unaffected (edit_file /
  // write_file operate on the real bytes).
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '');
  oldStr = norm(oldStr);
  newStr = norm(newStr);
  if (oldStr === newStr) return '';
  const a = oldStr === '' ? [] : oldStr.split('\n');
  const b = newStr === '' ? [] : newStr.split('\n');
  const ops = lcsOps(a, b);
  const hunks = toHunks(ops, context);
  if (!hunks.length) return '';

  // Line numbers for the @@ header.
  const out = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const [start, end] of hunks) {
    // advance counters over the gap before this hunk
    for (; cursor < start; cursor++) {
      if (ops[cursor][0] !== '+') oldLine++;
      if (ops[cursor][0] !== '-') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let k = start; k < end; k++) {
      const [sign, line] = ops[k];
      body.push(`${sign}${line}`);
      if (sign !== '+') oldCount++;
      if (sign !== '-') newCount++;
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    out.push(...body);
    oldLine += oldCount;
    newLine += newCount;
    cursor = end;
  }
  return out.join('\n');
}

// A one-line "+N -M" summary of a diff string, for step labels.
export function diffStat(diff) {
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}
