import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { loadConfig } from './config.js';
import { startHealthChecker, stopHealthChecker, getStatusSnapshot } from './healthChecker.js';
import { attachWebSocketServer } from './ws.js';
import { servicesRouter } from './routes/services.js';
import { groupsRouter } from './routes/groups.js';
import { connectionsRouter } from './routes/connections.js';
import { settingsRouter } from './routes/settings.js';
import { filesRouter } from './routes/files.js';
import { chatRouter } from './routes/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

app.get('/api/config', async (req, res) => {
  const config = await loadConfig();
  res.json(config);
});

app.get('/api/status', (req, res) => {
  res.json({ services: getStatusSnapshot() });
});

app.use('/api/services', servicesRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/files', filesRouter);
app.use('/api/chat', chatRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

const config = await loadConfig();
const PORT = process.env.PORT ? Number(process.env.PORT) : config.settings.port;

startHealthChecker(loadConfig);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission Control running:`);
  console.log(`  → http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  → http://${addr}:${PORT}`);
  }
});

const wss = attachWebSocketServer(server);

function shutdown() {
  stopHealthChecker();
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
