import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { checkNow, checkOneService, forgetService } from '../healthChecker.js';
import { sendMagicPacket, isValidMac } from '../wol.js';
import { controlService } from '../serviceControl.js';
import { getContainerLogs } from '../docker.js';
import { addService, normalizeController, normalizeGame } from '../serviceStore.js';
import { deleteServiceIcon } from '../serviceIcons.js';
import { getGameStatus, runGameCommand } from '../gameServers.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const servicesRouter = Router();

servicesRouter.post('/', async (req, res) => {
  const result = await addService(req.body, { via: clientIp(req) });
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result.service);
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

  const mac = body.mac !== undefined ? body.mac.trim() : existing.mac;
  if (mac && !isValidMac(mac)) {
    return res.status(400).json({ error: 'mac must look like AA:BB:CC:DD:EE:FF' });
  }

  config.services[idx] = {
    ...existing,
    name: body.name ?? existing.name,
    url: body.url ?? existing.url,
    group: body.group !== undefined ? body.group : existing.group,
    icon: body.icon ?? existing.icon,
    description: body.description ?? existing.description,
    healthCheck: body.healthCheck !== undefined ? !!body.healthCheck : existing.healthCheck,
    healthCheckPath: body.healthCheckPath ?? existing.healthCheckPath,
    tailscaleHealthCheck: body.tailscaleHealthCheck !== undefined ? !!body.tailscaleHealthCheck : existing.tailscaleHealthCheck,
    tags: Array.isArray(body.tags) ? body.tags : existing.tags,
    pinned: body.pinned !== undefined ? !!body.pinned : existing.pinned,
    mac,
    controller: normalizeController(body.controller, existing.controller),
    game: normalizeGame(body.game, existing.game),
  };

  await saveConfig(config);
  logActivity('service', `Updated "${config.services[idx].name}"`, clientIp(req));
  checkNow(loadConfig).catch(() => {});
  res.json(config.services[idx]);
});

servicesRouter.delete('/:id', async (req, res) => {
  const config = await loadConfig();
  const idx = config.services.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'service not found' });

  const deletedName = config.services[idx].name;
  config.services.splice(idx, 1);
  config.connections = config.connections.filter(
    (c) => c.from !== req.params.id && c.to !== req.params.id
  );
  await saveConfig(config);
  forgetService(req.params.id);
  deleteServiceIcon(req.params.id).catch(() => {}); // generated icon, if any (creative roadmap Phase 1b)
  logActivity('service', `Deleted "${deletedName}"`, clientIp(req));
  // Anything that depended on the deleted service should stop showing
  // degraded immediately rather than waiting out the rest of the current
  // sweep interval — create/update already do this, delete was missing it.
  checkNow(loadConfig).catch(() => {});
  res.status(204).end();
});

// On-demand recheck for a single service — used by the card's "check now"
// quick action so you don't have to wait for the next scheduled sweep.
servicesRouter.post('/:id/check', async (req, res) => {
  const status = await checkOneService(loadConfig, req.params.id);
  if (!status) return res.status(404).json({ error: 'service not found' });
  res.json(status);
});

// Sends a Wake-on-LAN magic packet to the service's saved MAC address —
// only meaningful for a service that's a whole machine (or whose host
// supports WOL), not a container/process running inside an already-awake
// host. Fire-and-forget from the caller's point of view: a successful send
// just means the broadcast went out, not that the device actually woke.
servicesRouter.post('/:id/wake', async (req, res) => {
  const config = await loadConfig();
  const service = config.services.find((s) => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'service not found' });
  if (!service.mac) return res.status(400).json({ error: 'this service has no MAC address saved' });

  try {
    await sendMagicPacket(service.mac);
    logActivity('service', `Sent Wake-on-LAN to "${service.name}"`, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const lastControlAttempt = new Map(); // `${serviceId}:${action}` -> timestamp
const CONTROL_COOLDOWN_MS = 2000; // guards against an accidental double-click/tap re-running a command

// The gate checks, controller dispatch, and activity logging all live in
// serviceControl.js#controlService (shared with the assistant's action
// tool). The route adds just the double-click cooldown, which is a
// button-press concern the tool path doesn't have.
async function handleControlAction(req, res, action) {
  const cooldownKey = `${req.params.id}:${action}`;
  if (Date.now() - (lastControlAttempt.get(cooldownKey) || 0) < CONTROL_COOLDOWN_MS) {
    return res.status(429).json({ error: 'that command just ran — give it a moment' });
  }
  lastControlAttempt.set(cooldownKey, Date.now());

  const result = await controlService(req.params.id, action, { via: clientIp(req) });
  res.status(result.ok ? 200 : 400).json(result);
}

servicesRouter.post('/:id/start', (req, res) => handleControlAction(req, res, 'start'));
servicesRouter.post('/:id/stop', (req, res) => handleControlAction(req, res, 'stop'));
servicesRouter.post('/:id/restart', (req, res) => handleControlAction(req, res, 'restart'));

// Read-only, so unlike start/stop/restart this only needs the app's normal
// session auth — not the security.serviceControl.enabled switch, since
// there's no command being run here, just a container's own log buffer
// being read. Only meaningful for a Docker-backed controller; a script
// controller has no equivalent place to read logs from.
servicesRouter.get('/:id/logs', async (req, res) => {
  const config = await loadConfig();
  const service = config.services.find((s) => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'service not found' });
  if (!service.controller || service.controller.type !== 'docker') {
    return res.status(400).json({ error: 'this service has no Docker container configured' });
  }

  const tail = Math.min(1000, Math.max(1, Number(req.query.tail) || 200));
  try {
    const logs = await getContainerLogs(service.controller.container, { tail });
    res.json({ logs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------- Game servers (creative roadmap Phase 5) ----------

// Player list + counts — read-only, so just a normal session (like /logs).
servicesRouter.get('/:id/game/status', async (req, res) => {
  const config = await loadConfig();
  const service = config.services.find((s) => s.id === req.params.id);
  if (!service?.game?.kind) return res.status(400).json({ error: 'this service is not a game server' });
  try {
    // the panel wants the full picture (player names + server info); the
    // health sweep calls getGameStatus() plain
    res.json({ online: true, ...(await getGameStatus(service.game, { full: true })) });
  } catch (err) {
    res.json({ online: false, error: err.message, players: [], max: null });
  }
});

// An RCON command can stop the server, ban players, grant op — so it gets the
// same double gate as Service Control: the switch AND password auth.
servicesRouter.post('/:id/game/command', async (req, res) => {
  const config = await loadConfig();
  const service = config.services.find((s) => s.id === req.params.id);
  if (!service?.game?.kind) return res.status(400).json({ error: 'this service is not a game server' });
  if (!config.security?.serviceControl?.enabled) {
    return res.status(403).json({ error: 'turn on Service Control (Settings → Security) to run game-server commands' });
  }
  if (!config.auth?.enabled) {
    return res.status(403).json({ error: 'game-server commands need password protection enabled first' });
  }
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'a command is required' });

  try {
    const output = await runGameCommand(service.game, command);
    logActivity('control', `Game command on "${service.name}": ${command.slice(0, 60)}`, clientIp(req));
    res.json({ output });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
