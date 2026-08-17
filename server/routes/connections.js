import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const connectionsRouter = Router();

const CONNECTION_TYPES = new Set(['related', 'depends-on']);

connectionsRouter.post('/', async (req, res) => {
  const config = await loadConfig();
  const { from, to, label } = req.body;
  const type = CONNECTION_TYPES.has(req.body.type) ? req.body.type : 'related';
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (from === to) return res.status(400).json({ error: 'a service cannot connect to itself' });
  const fromService = config.services.find((s) => s.id === from);
  const toService = config.services.find((s) => s.id === to);
  if (!fromService || !toService) {
    return res.status(400).json({ error: 'from/to must reference existing service ids' });
  }

  const connection = { id: `conn-${Date.now()}`, from, to, label: label || '', type };
  config.connections.push(connection);
  await saveConfig(config);
  logActivity(
    'connection',
    type === 'depends-on'
      ? `"${fromService.name}" now depends on "${toService.name}"`
      : `Connected "${fromService.name}" ↔ "${toService.name}"`,
    clientIp(req)
  );
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
  logActivity(
    'connection',
    removed.type === 'depends-on'
      ? `"${fromName}" no longer depends on "${toName}"`
      : `Disconnected "${fromName}" ↔ "${toName}"`,
    clientIp(req)
  );
  res.status(204).end();
});
