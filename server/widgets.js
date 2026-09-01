// Creative roadmap, Phase 3 — the Board view's widgets. `config.widgets` is a
// flat list of tiles (like `config.services`), shown in a 4th dashboard view
// mode. This module is just validation — routes/widgets.js does the CRUD and
// saveConfig() broadcasts the change like any other config edit.
//
// Types: iframe (embed a URL), note (markdown), links (shortcut cluster),
// fetch (server GETs a JSON/text endpoint, dodging CORS, renders one value
// via a {{ path }} template), jellyfin (Phase 4 — now-playing, no per-widget
// fields), and ops-roadmap Phase 2: host-stats (CPU/mem/disk sparklines, no
// fields), service-status (picked service dots), clock (a timezone), countdown
// (to a datetime); Phase 2b: photo (rotates images from a shared-folder
// subdir — reuses /api/files, no new serving path), docker (raw-container
// state + start/stop/restart/logs, controls Service-Control-gated). No
// arbitrary-script widget — that's a sandbox this app isn't taking on.

const TYPES = new Set([
  'iframe', 'note', 'links', 'fetch', 'jellyfin',
  'host-stats', 'service-status', 'clock', 'countdown',
  'photo', 'docker',
]);
const SIZES = new Set(['sm', 'md', 'lg']);

const MAX_TITLE = 60;
const MAX_URL = 2000;
const MAX_MARKDOWN = 4000;
const MAX_LINKS = 12;
const MAX_LINK_LABEL = 60;
const MAX_TEMPLATE = 500;
const MAX_STATUS_SERVICES = 16;
const MAX_DOCKER_CONTAINERS = 16;
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const clampInt = (v, lo, hi, fb) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

const str = (v, cap) => (typeof v === 'string' ? v.trim().slice(0, cap) : '');

// Returns { error } or { widget }. `existing` (on an edit) supplies the id and
// a fallback for any field the body leaves out. The type can't change on an
// edit — a tile is the type it was created as.
export function sanitizeWidget(body, existing = null) {
  const type = existing ? existing.type : body.type;
  if (!TYPES.has(type)) return { error: `unknown widget type: ${type}` };

  const widget = {
    id: existing?.id || `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    title: body.title !== undefined ? str(body.title, MAX_TITLE) : (existing?.title || ''),
    size: SIZES.has(body.size) ? body.size : (existing?.size || 'sm'),
  };

  if (type === 'iframe') {
    const url = body.url !== undefined ? str(body.url, MAX_URL) : (existing?.url || '');
    if (!/^https?:\/\//i.test(url)) return { error: 'the iframe URL must start with http:// or https://' };
    widget.url = url;
    widget.height = clampInt(body.height ?? existing?.height, 120, 900, 260);
  } else if (type === 'fetch') {
    const url = body.url !== undefined ? str(body.url, MAX_URL) : (existing?.url || '');
    if (!/^https?:\/\//i.test(url)) return { error: 'the endpoint URL must start with http:// or https://' };
    widget.url = url;
    widget.template = body.template !== undefined ? str(body.template, MAX_TEMPLATE) : (existing?.template || '');
    widget.refreshSec = clampInt(body.refreshSec ?? existing?.refreshSec, 10, 3600, 60);
  } else if (type === 'note') {
    widget.markdown = body.markdown !== undefined ? str(body.markdown, MAX_MARKDOWN) : (existing?.markdown || '');
  } else if (type === 'links') {
    const raw = Array.isArray(body.links) ? body.links : existing?.links || [];
    widget.links = raw
      .map((l) => ({ label: str(l?.label, MAX_LINK_LABEL), url: str(l?.url, MAX_URL) }))
      .filter((l) => l.url && /^https?:\/\//i.test(l.url))
      .slice(0, MAX_LINKS);
  } else if (type === 'service-status') {
    const raw = Array.isArray(body.serviceIds) ? body.serviceIds : existing?.serviceIds || [];
    widget.serviceIds = raw
      .filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id))
      .slice(0, MAX_STATUS_SERVICES);
  } else if (type === 'clock') {
    // An IANA zone, or '' for the viewer's local time. Validated by trying it.
    let tz = body.timezone !== undefined ? str(body.timezone, 60) : (existing?.timezone || '');
    if (tz) {
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = ''; }
    }
    widget.timezone = tz;
    widget.showSeconds = body.showSeconds !== undefined ? !!body.showSeconds : !!existing?.showSeconds;
    widget.showDate = body.showDate !== undefined ? !!body.showDate : (existing?.showDate ?? true);
  } else if (type === 'countdown') {
    const target = body.target !== undefined ? str(body.target, 40) : (existing?.target || '');
    if (target && Number.isNaN(Date.parse(target))) return { error: 'countdown target is not a valid date/time' };
    widget.target = target;
    widget.label = body.label !== undefined ? str(body.label, MAX_TITLE) : (existing?.label || '');
  } else if (type === 'photo') {
    // A path relative to the shared folder. The Files routes' safeResolve
    // still guards the actual reads — this is just an early reject of the
    // obviously-hostile so a bad value never reaches them.
    let folder = body.folder !== undefined ? str(body.folder, 400) : (existing?.folder || '');
    folder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some((seg) => seg === '..')) return { error: 'the photo folder path can\'t contain ".."' };
    widget.folder = folder;
    widget.rotateSec = clampInt(body.rotateSec ?? existing?.rotateSec, 5, 3600, 20);
    const fit = body.fit !== undefined ? body.fit : existing?.fit;
    widget.fit = fit === 'contain' ? 'contain' : 'cover';
    widget.shuffle = body.shuffle !== undefined ? !!body.shuffle : (existing?.shuffle ?? true);
  } else if (type === 'docker') {
    const raw = Array.isArray(body.containers) ? body.containers : existing?.containers || [];
    widget.containers = raw
      .filter((n) => typeof n === 'string' && DOCKER_NAME_RE.test(n.trim()))
      .map((n) => n.trim())
      .slice(0, MAX_DOCKER_CONTAINERS);
  }
  // host-stats has no fields.

  return { widget };
}
