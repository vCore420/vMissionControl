// Creative roadmap, Phase 3 — CRUD for the Board view's widgets. Same shape
// as routes/groups.js: mutate config.widgets, saveConfig() broadcasts it.
// Just the app's normal session — a widget is display config, nothing runs on
// the host (an iframe renders in the browser, sandboxed; see widgets.js).

import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { sanitizeWidget } from '../widgets.js';
import { addWidget, withArticle } from '../widgetStore.js';
import { fetchWidgetValue } from '../widgetFetch.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const widgetsRouter = Router();

// Registered before '/:id' so Express doesn't match 'reorder' as an id.
widgetsRouter.put('/reorder', async (req, res) => {
  const config = await loadConfig();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const known = new Set((config.widgets || []).map((w) => w.id));
  if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
    return res.status(400).json({ error: 'reorder list must be exactly the current widget ids' });
  }
  const byId = new Map(config.widgets.map((w) => [w.id, w]));
  config.widgets = ids.map((id) => byId.get(id));
  await saveConfig(config);
  res.json({ ok: true });
});

widgetsRouter.post('/', async (req, res) => {
  const { widget, error } = await addWidget(req.body || {}, { via: clientIp(req) });
  if (error) return res.status(400).json({ error });
  res.status(201).json(widget);
});

widgetsRouter.put('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = (config.widgets || []).findIndex((w) => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'widget not found' });

  const { widget, error } = sanitizeWidget(req.body || {}, config.widgets[idx]);
  if (error) return res.status(400).json({ error });

  config.widgets[idx] = widget;
  await saveConfig(config);
  logActivity('settings', `Updated ${withArticle(widget.type)} widget${widget.title ? ` ("${widget.title}")` : ''}`, clientIp(req));
  res.json(widget);
});

widgetsRouter.delete('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = (config.widgets || []).findIndex((w) => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'widget not found' });

  const [removed] = config.widgets.splice(idx, 1);
  await saveConfig(config);
  logActivity('settings', `Removed ${withArticle(removed.type)} widget${removed.title ? ` ("${removed.title}")` : ''}`, clientIp(req));
  res.status(204).end();
});

// The 'fetch' widget's data — the board polls this on the widget's own
// interval. The server does the actual HTTP GET (CORS-free) and renders one
// value through the template. Errors come back 200 with { error } so the
// tile shows them inline instead of the poll just failing.
widgetsRouter.get('/:id/value', async (req, res) => {
  const config = await loadConfig();
  const widget = (config.widgets || []).find((w) => w.id === req.params.id);
  if (!widget) return res.status(404).json({ error: 'widget not found' });
  if (widget.type !== 'fetch') return res.status(400).json({ error: 'not a fetch widget' });
  res.json(await fetchWidgetValue(widget));
});
