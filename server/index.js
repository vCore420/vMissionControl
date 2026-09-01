import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { dockerRouter } from './routes/docker.js';
import { configTransferRouter } from './routes/configTransfer.js';
import { timesheetRouter } from './routes/timesheet.js';
import { ollamaRouter } from './routes/ollama.js';
import { codeRouter } from './routes/code.js';
import { comfyRouter } from './routes/comfy.js';
import { artRouter } from './routes/art.js';
import { snippetsRouter } from './routes/snippets.js';
import { widgetsRouter } from './routes/widgets.js';
import { jellyfinRouter } from './routes/jellyfin.js';
import { activityRouter } from './routes/activity.js';
import { schedulesRouter } from './routes/schedules.js';
import { profileRouter } from './routes/profile.js';
import { authRouter } from './routes/auth.js';
import { initOllamaChat } from './ollamaChat.js';
import { initOllamaActions } from './ollamaActions.js';
import { initCodeAgent } from './codeAgent.js';
import { initBackgroundReaper, stopBackgroundReaper, stopAllBackground } from './codeBackground.js';
import { initComfy } from './comfyLifecycle.js';
import { requireAuth, requireCsrfHeader } from './auth.js';
import { requireIpAllowlist } from './ipAllowlist.js';
import { recordDevice } from './devices.js';
import { clientIp, lanAddresses } from './net.js';
import { startHostHealthSampler, stopHostHealthSampler, getHostHealthSnapshot, getHostHistory } from './host.js';
import { initScheduler, stopScheduler } from './scheduler.js';
import { pruneOldLogs, logActivity } from './activityLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// A Code message can carry base64 image attachments (codeImages.js: up to
// 4 MB decoded × 4 ≈ 22 MB base64), so /api/code parses first with a bigger
// limit; every other route gets the modest 3 MB one (a text-attachment Code
// message or a config import is the largest of those). Per-field caps in the
// routes still bound the real payload; express.json skips a body already
// parsed, so the first matching parser wins.
app.use('/api/code', express.json({ limit: '24mb' }));
app.use(express.json({ limit: '3mb' }));

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
  const snap = getHostHealthSnapshot();
  // The Board's host-stats widget asks for ?history=1; the header pill doesn't
  // (no point re-sending ~120 samples on its 10s poll).
  if (req.query.history) return res.json({ ...snap, history: getHostHistory() });
  res.json(snap);
});

app.use('/api/services', servicesRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/files', filesRouter);
app.use('/api/chat', chatRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/discovery', discoveryRouter);
app.use('/api/docker', dockerRouter);
app.use('/api/config', configTransferRouter);
app.use('/api/timesheet', timesheetRouter);
app.use('/api/ollama', ollamaRouter);
app.use('/api/code', codeRouter);
app.use('/api/comfy', comfyRouter);
app.use('/api/art', artRouter);
app.use('/api/snippets', snippetsRouter);
app.use('/api/widgets', widgetsRouter);
app.use('/api/jellyfin', jellyfinRouter);
app.use('/api/activity', activityRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/profile', profileRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const config = await loadConfig();
const PORT = process.env.PORT ? Number(process.env.PORT) : config.settings.port;

await pruneOldLogs();
startHealthChecker(loadConfig);
startHostHealthSampler();
initScheduler();
// If the Ollama assistant was left on, warm the model back up on boot —
// its on/off state lives in config.json, not memory.
initOllamaChat().catch((err) => console.error('[ollama] init failed:', err.message));
initOllamaActions();
initCodeAgent();
initBackgroundReaper();
initComfy();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission Control running:`);
  console.log(`  → http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  → http://${addr}:${PORT}`);
  }
  logActivity('system', 'Mission Control started');
});

// Without this, a second instance started on an already-occupied port dies
// with a raw EADDRINUSE stack trace — technically correct, not exactly
// pointing anyone at what to do about it. An orphaned instance left
// running after a window was closed the wrong way (see stop.bat) is
// exactly the case this is for.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — Mission Control (or something else) is already running.`);
    console.error(`Run stop.bat first, or check what's using this port before starting another instance.\n`);
    process.exit(1);
  }
  throw err;
});

const wss = attachWebSocketServer(server);

function shutdown() {
  logActivity('system', 'Mission Control shutting down');
  stopHealthChecker();
  stopHostHealthSampler();
  stopScheduler();
  stopBackgroundReaper();
  stopAllBackground();
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
