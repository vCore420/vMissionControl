import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const groupsRouter = Router();

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `group-${Date.now()}`
  );
}

groupsRouter.post('/', async (req, res) => {
  const config = await loadConfig();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  let id = slugify(name);
  if (config.groups.some((g) => g.id === id)) id = `${id}-${Date.now()}`;

  const group = { id, name, color: color || '#8888ff' };
  config.groups.push(group);
  await saveConfig(config);
  logActivity('group', `Created "${group.name}"`, clientIp(req));
  res.status(201).json(group);
});

groupsRouter.put('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.groups.findIndex((g) => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'group not found' });

  const existing = config.groups[idx];
  config.groups[idx] = {
    ...existing,
    name: req.body.name ?? existing.name,
    color: req.body.color ?? existing.color,
  };
  await saveConfig(config);
  logActivity('group', `Updated "${config.groups[idx].name}"`, clientIp(req));
  res.json(config.groups[idx]);
});

groupsRouter.delete('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.groups.findIndex((g) => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'group not found' });

  const deletedName = config.groups[idx].name;
  config.groups.splice(idx, 1);
  config.services.forEach((s) => {
    if (s.group === req.params.id) s.group = null;
  });
  await saveConfig(config);
  logActivity('group', `Deleted "${deletedName}"`, clientIp(req));
  res.status(204).end();
});
