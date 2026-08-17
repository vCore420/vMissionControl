import { Router } from 'express';
import { loadConfig, saveConfig } from '../config.js';
import { checkNow, checkOneService, forgetService } from '../healthChecker.js';
import { sendMagicPacket, isValidMac } from '../wol.js';
import { runControlCommand } from '../serviceControl.js';
import { dockerContainerAction, getContainerLogs } from '../docker.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const servicesRouter = Router();

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `service-${Date.now()}`
  );
}

// Two controller types: 'script' (Wave A — arbitrary shell commands, one
// per action, each optional so a service can have e.g. just a restart
// hook) and 'docker' (Wave B — a container name/id; start/stop/restart are
// standardized by the Docker Engine API itself, so there's nothing to
// configure per-action beyond which container). Anything without a
// meaningful value collapses to null rather than an empty-but-truthy
// object, so "has a controller" stays a reliable check everywhere else.
function normalizeController(body, existing) {
  if (body.controller === undefined) return existing ?? null;
  if (!body.controller || !body.controller.type) return null;
  const c = body.controller;

  if (c.type === 'docker') {
    const container = (c.container || '').trim();
    return container ? { type: 'docker', container } : null;
  }

  const startCmd = (c.startCmd || '').trim();
  const stopCmd = (c.stopCmd || '').trim();
  const restartCmd = (c.restartCmd || '').trim();
  return startCmd || stopCmd || restartCmd ? { type: 'script', startCmd, stopCmd, restartCmd } : null;
}

servicesRouter.post('/', async (req, res) => {
  const config = await loadConfig();
  const body = req.body;
  if (!body.name || !body.url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  const mac = (body.mac || '').trim();
  if (mac && !isValidMac(mac)) {
    return res.status(400).json({ error: 'mac must look like AA:BB:CC:DD:EE:FF' });
  }

  let id = slugify(body.name);
  if (config.services.some((s) => s.id === id)) id = `${id}-${Date.now()}`;

  const service = {
    id,
    name: body.name,
    url: body.url,
    group: body.group || null,
    icon: (body.icon || '').trim(),
    description: body.description || '',
    healthCheck: body.healthCheck !== false,
    healthCheckPath: body.healthCheckPath || '/',
    tailscaleHealthCheck: body.tailscaleHealthCheck === true,
    tags: Array.isArray(body.tags) ? body.tags : [],
    pinned: body.pinned === true,
    mac,
    controller: normalizeController(body, null),
  };

  config.services.push(service);
  await saveConfig(config);
  logActivity('service', `Created "${service.name}" (${service.url})`, clientIp(req));
  checkNow(loadConfig).catch(() => {});
  res.status(201).json(service);
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
    controller: normalizeController(body, existing.controller),
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

const CONTROL_ACTIONS = {
  start: { field: 'startCmd', verb: 'start' },
  stop: { field: 'stopCmd', verb: 'stop' },
  restart: { field: 'restartCmd', verb: 'restart' },
};

const lastControlAttempt = new Map(); // `${serviceId}:${action}` -> timestamp
const CONTROL_COOLDOWN_MS = 2000; // guards against an accidental double-click/tap re-running a command

// Runs a service's configured start/stop/restart command on the host.
// Gated behind two independent switches on top of the app's normal
// auth/session checks: security.serviceControl.enabled (an explicit opt-in
// separate from just having a password set) and auth.enabled itself (this
// feature runs commands on the host, so Settings won't let it be turned on
// without password protection already active — see routes/settings.js).
// Websites are excluded by convention, not by code: nothing stops someone
// from pointing a controller at a website entry, but the Add/Edit modal
// only surfaces these fields as an opt-in "advanced" section, so a website
// simply never gets one filled in.
async function handleControlAction(req, res, action) {
  const config = await loadConfig();
  if (!config.security?.serviceControl?.enabled) {
    return res.status(403).json({ error: 'Service control is off — turn it on in Settings → Security.' });
  }
  if (!config.auth?.enabled) {
    return res.status(403).json({ error: 'Service control requires password protection to be enabled first.' });
  }

  const service = config.services.find((s) => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'service not found' });
  if (!service.controller) {
    return res.status(400).json({ error: 'this service has no control commands configured' });
  }

  const { verb } = CONTROL_ACTIONS[action];
  let run;

  if (service.controller.type === 'script') {
    const cmd = service.controller[CONTROL_ACTIONS[action].field];
    if (!cmd) return res.status(400).json({ error: `no ${verb} command configured for this service` });
    run = () => runControlCommand(cmd);
  } else if (service.controller.type === 'docker') {
    const container = service.controller.container;
    run = async () => {
      try {
        await dockerContainerAction(container, action);
        return { ok: true, output: `Docker ${verb} sent to "${container}"` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };
  } else {
    return res.status(400).json({ error: 'unsupported controller type' });
  }

  const cooldownKey = `${service.id}:${action}`;
  const lastAttempt = lastControlAttempt.get(cooldownKey) || 0;
  if (Date.now() - lastAttempt < CONTROL_COOLDOWN_MS) {
    return res.status(429).json({ error: 'that command just ran — give it a moment' });
  }
  lastControlAttempt.set(cooldownKey, Date.now());

  logActivity('control', `Running ${verb} for "${service.name}"`, clientIp(req));
  const result = await run();
  logActivity(
    'control',
    result.ok
      ? `"${service.name}" ${verb} succeeded`
      : `"${service.name}" ${verb} failed: ${result.error || 'unknown error'}`,
    clientIp(req)
  );

  // Give the process a moment to actually change state before the health
  // checker looks again, rather than racing it and reporting stale status.
  setTimeout(() => {
    checkOneService(loadConfig, service.id).catch(() => {});
  }, 3000);

  res.json(result);
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
