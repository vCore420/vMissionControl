// Adding a Board widget — the shared implementation behind
// routes/widgets.js (the modal's "Add a widget") and the assistant's
// add_widget action tool (ops roadmap Phase 3b). Same split as
// serviceStore.js: validation, the count cap, and activity logging live
// here so a config written by hand or by the assistant stays consistent.

import { loadConfig, saveConfig } from './config.js';
import { sanitizeWidget } from './widgets.js';
import { logActivity } from './activityLog.js';

export const MAX_WIDGETS = 30;

export const withArticle = (type) => `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;

// Returns { error } or { widget }. Never throws. `via` is the client IP
// (route) or a label like 'the assistant' (action tool) — the IP form is
// passed through to logActivity, the label isn't.
export async function addWidget(body, { via = null } = {}) {
  const config = await loadConfig();
  if (!config.widgets) config.widgets = [];
  if (config.widgets.length >= MAX_WIDGETS) {
    return { error: `that's the ${MAX_WIDGETS}-widget limit` };
  }
  const { widget, error } = sanitizeWidget(body || {});
  if (error) return { error };

  config.widgets.push(widget);
  await saveConfig(config);
  logActivity(
    'settings',
    `Added ${withArticle(widget.type)} widget${widget.title ? ` ("${widget.title}")` : ''}${via && !via.includes('.') ? ` via ${via}` : ''}`,
    via && via.includes('.') ? via : null
  );
  return { widget };
}
