import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const connectionsRouter = Router();

connectionsRouter.post('/', async (req, res) => {
  const config = await loadConfig();
  const { from, to, label } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  const fromService = config.services.find((s) => s.id === from);
  const toService = config.services.find((s) => s.id === to);
  if (!fromService || !toService) {
    return res.status(400).json({ error: 'from/to must reference existing service ids' });
  }

  const connection = { id: `conn-${Date.now()}`, from, to, label: label || '' };
  config.connections.push(connection);
  await saveConfig(config);
  logActivity('connection', `Connected "${fromService.name}" ↔ "${toService.name}"`, clientIp(req));
  res.status(201).json(connection);
});

connectionsRouter.delete('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.connections.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'connection not found' });

  const removed = config.connections[idx];
  const fromName = config.services.find((s) => s.id === removed.from)?.name ?? removed.from;
  const toName = config.services.find((s) => s.id === removed.to)?.name ?? removed.to;
  config.connections.splice(idx, 1);
  await saveConfig(config);
  logActivity('connection', `Disconnected "${fromName}" ↔ "${toName}"`, clientIp(req));
  res.status(204).end();
});
