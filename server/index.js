import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { loadConfig, sanitizeConfig } from './config.js';
import { startHealthChecker, stopHealthChecker, getStatusSnapshot } from './healthChecker.js';
import { attachWebSocketServer } from './ws.js';
import { servicesRouter } from './routes/services.js';
import { groupsRouter } from './routes/groups.js';
import { connectionsRouter } from './routes/connections.js';
import { settingsRouter } from './routes/settings.js';
import { filesRouter } from './routes/files.js';
import { chatRouter } from './routes/chat.js';
import { devicesRouter } from './routes/devices.js';
import { discoveryRouter } from './routes/discovery.js';
import { configTransferRouter } from './routes/configTransfer.js';
import { authRouter } from './routes/auth.js';
import { requireAuth, requireCsrfHeader } from './auth.js';
import { requireIpAllowlist } from './ipAllowlist.js';
import { recordDevice } from './devices.js';
import { clientIp } from './net.js';
import { startHostHealthSampler, stopHostHealthSampler, getHostHealthSnapshot } from './host.js';
import { pruneOldLogs, logActivity } from './activityLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// The IP allowlist (Settings → Security, off by default) runs before
// anything else — a disallowed request never gets recorded as a device or
// offered the login page, it's just rejected outright.
app.use(requireIpAllowlist);

app.use((req, res, next) => {
  recordDevice(clientIp(req), req.headers['user-agent']);
  next();
});

// Everything below this line is gated when Settings → Security has a
// password set — see auth.js for the public-path allowlist (just enough
// to render /login.html and let it submit a password) and README's
// Security note for why this is a doorlock, not a user-account system.
app.use(requireAuth);
app.use(requireCsrfHeader);
app.use('/api/auth', authRouter);

app.get('/api/config', async (req, res) => {
  const config = await loadConfig();
  res.json(sanitizeConfig(config));
});

app.get('/api/status', (req, res) => {
  res.json({ services: getStatusSnapshot() });
});

app.get('/api/host', (req, res) => {
  res.json(getHostHealthSnapshot());
});

app.use('/api/services', servicesRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/files', filesRouter);
app.use('/api/chat', chatRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/discovery', discoveryRouter);
app.use('/api/config', configTransferRouter);

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

await pruneOldLogs();
startHealthChecker(loadConfig);
startHostHealthSampler();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission Control running:`);
  console.log(`  → http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  → http://${addr}:${PORT}`);
  }
  logActivity('system', 'Mission Control started');
});

const wss = attachWebSocketServer(server);

function shutdown() {
  logActivity('system', 'Mission Control shutting down');
  stopHealthChecker();
  stopHostHealthSampler();
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
