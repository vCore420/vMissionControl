// Profile avatars (Phase 11) — a deterministic SVG "sprite" generated from a
// seed string, plus a helper that renders whatever a profile actually has
// (uploaded image, chosen sprite, or a name-seeded sprite fallback). Shared
// by settings.js (the Profile tab), chat.js and code.js (message meta).
//
// Dependency-free on purpose — every view module imports it. The sprite
// algorithm must stay stable: changing it re-rolls everyone's fallback face.

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A GitHub-style identicon: a 5×5 grid, left-right symmetric (3 unique
// columns), cells filled from 15 bits of one hash, hue from another so the
// colour doesn't track the pattern. Renders at any size via the viewBox.
export function spriteSvg(seed) {
  const s = String(seed || '?');
  const pattern = hashStr(s);
  const hue = hashStr(s + '§') % 360;
  const fg = `hsl(${hue} 58% 46%)`;
  const bg = `hsl(${hue} 45% 90%)`;

  let cells = '';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if ((pattern >> (r * 3 + c)) & 1) {
        const mirror = 4 - c;
        cells += `<rect x="${c * 20 + 1}" y="${r * 20 + 1}" width="18" height="18" rx="3"/>`;
        if (mirror !== c) cells += `<rect x="${mirror * 20 + 1}" y="${r * 20 + 1}" width="18" height="18" rx="3"/>`;
      }
    }
  }
  return (
    `<svg class="mc-sprite" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<rect width="100" height="100" rx="16" fill="${bg}"/>` +
    `<g fill="${fg}">${cells}</g>` +
    `</svg>`
  );
}

export function avatarImageUrl(avatar) {
  return avatar?.kind === 'image' && avatar.file
    ? `/api/profile/avatar/${encodeURIComponent(avatar.file)}${avatar.updatedAt ? `?t=${avatar.updatedAt}` : ''}`
    : null;
}

// HTML for a profile's avatar. `profile` may be undefined (never seen this
// device) — then the sprite is seeded from `fallbackName` so there's always
// a face. Wrap in a `.mc-avatar` span; size it via CSS on that span.
export function avatarMarkup(profile, fallbackName = '?') {
  const url = avatarImageUrl(profile?.avatar);
  if (url) {
    return `<span class="mc-avatar"><img src="${url}" alt="" loading="lazy" decoding="async"></span>`;
  }
  const seed = profile?.avatar?.kind === 'sprite' ? profile.avatar.seed : profile?.name || fallbackName;
  return `<span class="mc-avatar">${spriteSvg(seed)}</span>`;
}
