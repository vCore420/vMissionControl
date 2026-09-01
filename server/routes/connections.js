import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { addConnection } from '../serviceStore.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const connectionsRouter = Router();

connectionsRouter.post('/', async (req, res) => {
  const { from, to, type, label } = req.body;
  const result = await addConnection({ from, to, type, label }, { via: clientIp(req) });
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result.connection);
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
