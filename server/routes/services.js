import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { checkNow, checkOneService, forgetService } from '../healthChecker.js';

export const servicesRouter = Router();

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `service-${Date.now()}`
  );
}

servicesRouter.post('/', async (req, res) => {
  const config = await loadConfig();
  const body = req.body;
  if (!body.name || !body.url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  let id = slugify(body.name);
  if (config.services.some((s) => s.id === id)) id = `${id}-${Date.now()}`;

  const service = {
    id,
    name: body.name,
    url: body.url,
    group: body.group || null,
    icon: (body.icon || '').trim(),
    description: body.description || '',
    healthCheck: body.healthCheck !== false,
    healthCheckPath: body.healthCheckPath || '/',
    tags: Array.isArray(body.tags) ? body.tags : [],
    pinned: body.pinned === true,
  };

  config.services.push(service);
  await saveConfig(config);
  checkNow(loadConfig).catch(() => {});
  res.status(201).json(service);
});

// Reorders a subsequence of services by id, leaving every other service's
// position untouched — this is what lets the pinned section and the main
// grid be dragged into their own order independently, since each drag only
// ever submits the ids visible in the container that was dragged.
// Must be registered before PUT '/:id' or Express would match 'reorder' as
// an :id param instead.
servicesRouter.put('/reorder', async (req, res) => {
  const config = await loadConfig();
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return res.status(400).json({ error: 'ids must be an array of service ids' });
  }
  const byId = new Map(config.services.map((s) => [s.id, s]));
  if (!ids.every((id) => byId.has(id))) {
    return res.status(400).json({ error: 'unknown service id in reorder list' });
  }

  const idSet = new Set(ids);
  let cursor = 0;
  config.services = config.services.map((s) => (idSet.has(s.id) ? byId.get(ids[cursor++]) : s));

  await saveConfig(config);
  res.json({ ok: true });
});

servicesRouter.put('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.services.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'service not found' });

  const existing = config.services[idx];
  const body = req.body;
  config.services[idx] = {
    ...existing,
    name: body.name ?? existing.name,
    url: body.url ?? existing.url,
    group: body.group !== undefined ? body.group : existing.group,
    icon: body.icon ?? existing.icon,
    description: body.description ?? existing.description,
    healthCheck: body.healthCheck !== undefined ? !!body.healthCheck : existing.healthCheck,
    healthCheckPath: body.healthCheckPath ?? existing.healthCheckPath,
    tags: Array.isArray(body.tags) ? body.tags : existing.tags,
    pinned: body.pinned !== undefined ? !!body.pinned : existing.pinned,
  };

  await saveConfig(config);
  checkNow(loadConfig).catch(() => {});
  res.json(config.services[idx]);
});

servicesRouter.delete('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.services.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'service not found' });

  config.services.splice(idx, 1);
  config.connections = config.connections.filter(
    (c) => c.from !== req.params.id && c.to !== req.params.id
  );
  await saveConfig(config);
  forgetService(req.params.id);
  res.status(204).end();
});

// On-demand recheck for a single service — used by the card's "check now"
// quick action so you don't have to wait for the next scheduled sweep.
servicesRouter.post('/:id/check', async (req, res) => {
  const status = await checkOneService(loadConfig, req.params.id);
  if (!status) return res.status(404).json({ error: 'service not found' });
  res.json(status);
});
