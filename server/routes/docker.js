import { Router } from 'express';
import { loadConfig } from '../config.js';
import { listDockerContainers, dockerContainerAction, getContainerLogs } from '../docker.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const dockerRouter = Router();

// Backs the "Browse…" container picker in the Add/Edit Service modal and the
// Board's 'docker' widget (ops roadmap Phase 2b) — read-only, so it only
// needs the app's normal session auth, same as the logs endpoint in
// routes/services.js.
dockerRouter.get('/containers', async (req, res) => {
  try {
    const containers = await listDockerContainers();
    res.json({ containers });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

// A raw container's recent log buffer — read-only, normal session auth, same
// reasoning as routes/services.js#/:id/logs (no command runs, just a read).
dockerRouter.get('/containers/:name/logs', async (req, res) => {
  if (!NAME_RE.test(req.params.name)) return res.status(400).json({ error: 'bad container name' });
  const tail = Math.min(1000, Math.max(1, Number(req.query.tail) || 200));
  try {
    const logs = await getContainerLogs(req.params.name, { tail });
    res.json({ logs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// start / stop / restart on a raw container. This runs a state change on the
// host's Docker daemon, so it gets the same double gate as Service Control
// and game-server commands: the security.serviceControl switch AND password
// auth (see serviceControl.js's header for why unauthorized triggering, not
// injection, is the risk).
const ACTIONS = new Set(['start', 'stop', 'restart']);
dockerRouter.post('/containers/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!ACTIONS.has(action)) return res.status(400).json({ error: `unsupported action: ${action}` });
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'bad container name' });

  const config = await loadConfig();
  if (!config.security?.serviceControl?.enabled) {
    return res.status(403).json({ error: 'turn on Service Control (Settings → Security) to control containers' });
  }
  if (!config.auth?.enabled) {
    return res.status(403).json({ error: 'container controls need password protection enabled first' });
  }

  try {
    await dockerContainerAction(name, action);
    logActivity('control', `Docker ${action} on container "${name}"`, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    logActivity('control', `Docker ${action} on container "${name}" failed: ${err.message}`, clientIp(req));
    res.status(502).json({ error: err.message });
  }
});
