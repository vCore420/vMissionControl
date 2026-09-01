// Config writes for adding a service or a connection between two — the
// shared implementation behind routes/services.js + routes/connections.js
// (the browser) and the assistant's add_service / add_connection action
// tools. Validation, id generation, activity logging, and the health
// recheck all live here; the routes and the tools just call in.

import { loadConfig, saveConfig } from './config.js';
import { checkNow } from './healthChecker.js';
import { isValidMac } from './wol.js';
import { logActivity } from './activityLog.js';

const CONNECTION_TYPES = new Set(['related', 'depends-on']);

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `service-${Date.now()}`
  );
}

// Builds a normalized controller object (or null) from loose input — the
// two shapes the Add/Edit modal produces, mirrored so a config edited by
// hand or by the assistant stays consistent.
export function normalizeController(controller, existing) {
  if (controller === undefined) return existing ?? null;
  if (!controller || !controller.type) return null;
  if (controller.type === 'docker') {
    const container = (controller.container || '').trim();
    return container ? { type: 'docker', container } : null;
  }
  const startCmd = (controller.startCmd || '').trim();
  const stopCmd = (controller.stopCmd || '').trim();
  const restartCmd = (controller.restartCmd || '').trim();
  return startCmd || stopCmd || restartCmd ? { type: 'script', startCmd, stopCmd, restartCmd } : null;
}

// A `game` field (creative roadmap Phase 5) turns a service into a game
// server — healthChecker.js checks it over RCON instead of an HTTP ping, and
// it gets a console + player list. The rconPassword is write-only: a blank
// one on an edit keeps whatever's saved (sanitizeConfig strips it before the
// config ever reaches a client).
export function normalizeGame(game, existing) {
  if (game === undefined) return existing ?? null;
  if (!game || !game.kind) return null;
  if (game.kind === 'minecraft') {
    const rconHost = (game.rconHost || '').trim();
    if (!rconHost) return null;
    const rconPort = Math.min(65535, Math.max(1, Math.round(Number(game.rconPort)) || 25575));
    const rconPassword =
      typeof game.rconPassword === 'string' && game.rconPassword.trim()
        ? game.rconPassword.trim()
        : existing?.kind === 'minecraft' ? existing.rconPassword || '' : '';
    return { kind: 'minecraft', rconHost, rconPort, rconPassword };
  }
  if (game.kind === 'fivem') {
    const queryUrl = (game.queryUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(queryUrl)) return null;
    const txAdminUrl = (game.txAdminUrl || '').trim().replace(/\/+$/, '');
    return {
      kind: 'fivem',
      queryUrl,
      ...(/^https?:\/\//i.test(txAdminUrl) ? { txAdminUrl } : {}),
    };
  }
  return existing ?? null; // unknown kind — don't clobber whatever's there
}

// Returns { error } or { service }. Never throws.
export async function addService(fields, { via = null } = {}) {
  if (!fields.name || !fields.url) return { error: 'name and url are required' };
  const mac = (fields.mac || '').trim();
  if (mac && !isValidMac(mac)) return { error: 'mac must look like AA:BB:CC:DD:EE:FF' };

  const config = await loadConfig();
  let id = slugify(fields.name);
  if (config.services.some((s) => s.id === id)) id = `${id}-${Date.now()}`;

  const service = {
    id,
    name: fields.name,
    url: fields.url,
    group: fields.group || null,
    icon: (fields.icon || '').trim(),
    description: fields.description || '',
    healthCheck: fields.healthCheck !== false,
    healthCheckPath: fields.healthCheckPath || '/',
    tailscaleHealthCheck: fields.tailscaleHealthCheck === true,
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    pinned: fields.pinned === true,
    mac,
    controller: normalizeController(fields.controller, null),
    game: normalizeGame(fields.game, null),
    iconImage: null, // set by the art route when an icon is generated (Phase 1b)
  };

  config.services.push(service);
  await saveConfig(config);
  logActivity('service', `Created "${service.name}" (${service.url})${via ? ` via ${via}` : ''}`, via && via.includes('.') ? via : null);
  checkNow(loadConfig).catch(() => {});
  return { service };
}

// Returns { error } or { connection }. Never throws.
export async function addConnection({ from, to, type, label }, { via = null } = {}) {
  if (!from || !to) return { error: 'from and to are required' };
  if (from === to) return { error: 'a service cannot connect to itself' };
  const connType = CONNECTION_TYPES.has(type) ? type : 'related';

  const config = await loadConfig();
  const fromService = config.services.find((s) => s.id === from);
  const toService = config.services.find((s) => s.id === to);
  if (!fromService || !toService) return { error: 'from/to must reference existing service ids' };
  if (config.connections.some((c) => c.from === from && c.to === to)) {
    return { error: `${fromService.name} and ${toService.name} are already connected` };
  }

  const connection = { id: `conn-${Date.now()}`, from, to, label: label || '', type: connType };
  config.connections.push(connection);
  await saveConfig(config);
  logActivity(
    'connection',
    connType === 'depends-on'
      ? `"${fromService.name}" now depends on "${toService.name}"${via ? ` (via ${via})` : ''}`
      : `Connected "${fromService.name}" ↔ "${toService.name}"${via ? ` (via ${via})` : ''}`
  );
  return { connection };
}
