import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';

export const connectionsRouter = Router();

connectionsRouter.post('/', async (req, res) => {
  const config = await loadConfig();
  const { from, to, label } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (!config.services.some((s) => s.id === from) || !config.services.some((s) => s.id === to)) {
    return res.status(400).json({ error: 'from/to must reference existing service ids' });
  }

  const connection = { id: `conn-${Date.now()}`, from, to, label: label || '' };
  config.connections.push(connection);
  await saveConfig(config);
  res.status(201).json(connection);
});

connectionsRouter.delete('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.connections.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'connection not found' });

  config.connections.splice(idx, 1);
  await saveConfig(config);
  res.status(204).end();
});
