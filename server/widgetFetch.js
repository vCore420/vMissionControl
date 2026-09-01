// Creative roadmap, Phase 3 wave 3b — the 'fetch' widget's server side. The
// browser can't GET an arbitrary cross-origin endpoint (CORS), so the board
// asks Mission Control to do it and hand back one rendered value.
//
// The server will fetch whatever URL is saved on the widget, including
// localhost / private addresses — that's the point (a Pi-hole or a router
// API on the LAN). Same trust model as Service Control: the URL is one you
// typed into the widget form, not one supplied per request. No allow/deny
// list — reaching internal services is what this app is for.

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_VALUE_CHARS = 240;

// Resolve a dotted / bracketed path into parsed JSON: "a.b.0.c", "items[2].name".
function getPath(obj, path) {
  return String(path)
    .split(/[.[\]]+/)
    .filter(Boolean)
    .reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

// A template with no {{ }} shows the raw body; otherwise each {{ path }} is
// replaced by the resolved value (or — when it's missing).
export function applyTemplate(template, data, rawText) {
  const tpl = (template || '').trim();
  if (!tpl.includes('{{')) {
    const raw = typeof data === 'object' && data !== null ? JSON.stringify(data) : String(rawText ?? data ?? '');
    return raw.trim().slice(0, MAX_VALUE_CHARS);
  }
  return tpl
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
      const v = getPath(data, path.trim());
      if (v == null) return '—';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    })
    .slice(0, MAX_VALUE_CHARS);
}

// Returns { value, fetchedAt } or { error, fetchedAt }. Never throws — a bad
// endpoint is the widget's problem to show, not a 500.
export async function fetchWidgetValue(widget) {
  const fetchedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(widget.url, { signal: controller.signal, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, MAX_BODY_BYTES).toString('utf-8');
    if (!res.ok) return { error: `endpoint returned ${res.status}`, fetchedAt };

    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON — template can still show the raw text */ }

    const value = applyTemplate(widget.template, data, text);
    return { value: value || '—', fetchedAt };
  } catch (err) {
    const msg =
      err.name === 'AbortError' ? `no response within ${FETCH_TIMEOUT_MS / 1000}s`
      : err.cause?.code === 'ECONNREFUSED' ? 'nothing is listening at that URL'
      : err.cause?.code === 'ENOTFOUND' ? "can't resolve that host"
      : err.message;
    return { error: msg, fetchedAt };
  } finally {
    clearTimeout(timer);
  }
}
