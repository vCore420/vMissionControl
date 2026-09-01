// Creative roadmap, Phase 1 — prompt composition for the three things
// ComfyUI generates for Mission Control: theme wallpapers (wave 1a), profile
// avatars and service icons (wave 1b). Each builder takes the human inputs
// and appends a fixed style/quality suffix that steers the output toward
// what that slot actually needs — an ambient backdrop, a centred portrait,
// a flat app icon.

// ---------- Wallpapers ----------
// One descriptive phrase per built-in theme (ids match public/js/settings.js's
// THEMES + 'custom', which has no fixed phrase — the frontend passes a colour
// hint as extraPrompt instead).

const THEME_ART = {
  dark: 'deep indigo-black gradient, faint violet nebula haze, minimal, calm',
  light: 'soft off-white, pale grey paper grain, airy, gentle diffuse light',
  cyberpunk: 'deep-violet synthwave haze, magenta and cyan neon glow, abstract geometric grid',
  pride: 'soft rainbow light leak across a dark field, smooth gradient bands, gentle',
  cute: 'pastel pink and lilac clouds, soft bokeh, dreamy, rounded shapes',
  cozy: 'warm amber lamplight, soft film grain, blurred fireplace bokeh, inviting',
  her: 'warm rose and mauve dusk haze, soft focus, tender, filmic tones',
  forest: 'misty pine canopy, layered green depth, soft shafts of light, painterly',
  ocean: 'deep teal water, slow caustic light patterns, smooth gradient, tranquil',
  matrix: 'pure black field, cascading green digital glyph rain, high contrast',
  nord: 'muted arctic blue-grey, soft snow gradient, cool minimal, frosted glass',
  sunset: 'orange to magenta gradient sky, low silhouette horizon, warm haze',
  vaporwave: 'pink and cyan neon grid horizon, chrome gradient, retro 1980s, subtle glitch',
  mono: 'pure greyscale, high-contrast abstract shapes, brutalist minimal',
  dracula: 'dark purple-grey base, muted magenta and cyan accents, soft glow, moody',
  solarized: 'dark teal base, warm ochre and muted blue accents, balanced, understated',
  highcontrast: 'pure black field, one bright cyan geometric accent, stark, bold',
};

const FALLBACK_ART = 'abstract gradient, soft ambient light, minimal composition';

const WALLPAPER_SUFFIX =
  'abstract desktop wallpaper, ambient background texture, no text, no words, ' +
  'no watermark, no people, no faces, seamless, atmospheric, high detail';

export function themeToArt(themeId) {
  return THEME_ART[themeId] || FALLBACK_ART;
}

export function buildWallpaperPrompt(themeId, extra) {
  const parts = [themeToArt(themeId)];
  const trimmed = (extra || '').trim();
  if (trimmed) parts.push(trimmed);
  parts.push(WALLPAPER_SUFFIX);
  return parts.join(', ');
}

// ---------- Avatars ----------
// The subject is whatever the user typed; the style is one of these presets
// (or none). ids match the chips in settings.js's profile section.

export const AVATAR_STYLES = {
  'pixel-art': 'pixel art, 8-bit, crisp pixels, limited palette',
  'flat-vector': 'flat vector illustration, bold simple shapes, clean',
  'oil-painting': 'oil painting, painterly brushwork, classical portrait',
  'anime': 'anime style, clean line art, cel shaded',
  '3d': 'stylised 3d render, soft studio lighting, smooth',
};

const AVATAR_SUFFIX = 'centered, plain simple background, avatar, profile picture, head and shoulders';

export function buildAvatarPrompt(subject, styleId) {
  const parts = [(subject || '').trim() || 'friendly abstract emblem'];
  if (AVATAR_STYLES[styleId]) parts.push(AVATAR_STYLES[styleId]);
  parts.push(AVATAR_SUFFIX);
  return parts.join(', ');
}

// ---------- Service icons ----------
// Built from the service's own name + description (+ any extra words). The
// suffix forces an icon shape rather than a scene or a screenshot.

const SERVICE_ICON_SUFFIX =
  'app icon, single centered symbol, flat minimal vector, bold simple shape, ' +
  'solid background, no text, no letters, no words, high contrast, crisp';

export function buildServiceIconPrompt({ name, description, extra } = {}) {
  const parts = [];
  if ((name || '').trim()) parts.push(`icon representing "${name.trim()}"`);
  if ((description || '').trim()) parts.push(description.trim());
  if ((extra || '').trim()) parts.push(extra.trim());
  if (!parts.length) parts.push('abstract app icon');
  parts.push(SERVICE_ICON_SUFFIX);
  return parts.join(', ');
}
