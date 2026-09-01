// Creative roadmap, Phase 5 — game-server helpers.
//   5a Minecraft: RCON (server/rcon.js). game = { kind:'minecraft', rconHost,
//      rconPort, rconPassword }.
//   5b FiveM: the FXServer's own HTTP endpoints on the game port —
//      /dynamic.json, /players.json, /info.json — no auth. game = {
//      kind:'fivem', queryUrl, txAdminUrl? }. Restart + console stay in
//      txAdmin (a link) — its control API needs a full master login.
// healthChecker.js game-checks a service with a `game` field instead of an
// HTTP ping; the console panel polls GET /:id/game/status.

import { rconCommand } from './rcon.js';

const FIVEM_TIMEOUT_MS = 4000;

// Minecraft's `list` output varies a little by version:
//   "There are 3 of a max of 20 players online: alice, bob, carol"
//   "There are 3/20 players online: alice, bob"
//   "There are 0 of a max of 20 players online:"
export function parsePlayerList(text) {
  const counts = text.match(/There are\s+(\d+)\s*(?:of a max of|\/)\s*(\d+)/i);
  const max = counts ? Number(counts[2]) : null;
  const namesPart = text.split(/online:?/i).slice(1).join('') || '';
  const players = namesPart
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^\s*$/.test(s));
  const online = counts ? Number(counts[1]) : players.length;
  return { online, max, players };
}

// Used by healthChecker.js — throws if RCON is unreachable / misconfigured, so
// the sweep marks the service offline with that message.
export async function getMinecraftStatus(game) {
  const text = await rconCommand({
    host: game.rconHost,
    port: game.rconPort,
    password: game.rconPassword,
    command: 'list',
    timeoutMs: 3000,
  });
  const parsed = parsePlayerList(text);
  return { online: true, count: parsed.online, max: parsed.max, players: parsed.players };
}

export async function runMinecraftCommand(game, command) {
  return rconCommand({
    host: game.rconHost,
    port: game.rconPort,
    password: game.rconPassword,
    command,
    timeoutMs: 6000,
  });
}

// ---------- FiveM ----------

async function fivemJson(baseUrl, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIVEM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`FiveM server at ${baseUrl} didn't respond`);
    if (err.cause?.code === 'ECONNREFUSED') throw new Error(`nothing is listening at ${baseUrl}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `full` (the console panel) also pulls the player names + server info;
// the health sweep only needs the count, so it passes full:false.
export async function getFivemStatus(game, { full = false } = {}) {
  const dyn = await fivemJson(game.queryUrl, '/dynamic.json');
  const out = {
    online: true,
    count: Number(dyn.clients) || 0,
    max: Number(dyn.sv_maxclients) || null,
    gametype: dyn.gametype || null,
    mapName: dyn.mapname || null,
    serverName: dyn.hostname || null,
    players: [],
  };
  if (!full) return out;

  const [players, info] = await Promise.all([
    fivemJson(game.queryUrl, '/players.json').catch(() => []),
    fivemJson(game.queryUrl, '/info.json').catch(() => null),
  ]);
  out.players = (Array.isArray(players) ? players : []).map((p) => ({
    name: p.name || 'unknown',
    ping: typeof p.ping === 'number' ? p.ping : null,
    id: p.id ?? null,
  }));
  if (info?.vars) {
    out.description = info.vars.sv_projectDesc || null;
    out.build = info.vars.sv_enforceGameBuild || null;
    out.serverName = out.serverName || info.vars.sv_projectName || null;
  }
  if (Array.isArray(info?.resources)) out.resourceCount = info.resources.length;
  return out;
}

// Dispatch by kind — one entry point for the routes + healthChecker.
// Returns { online, max, players, ... } — `players` is a list of names
// (Minecraft) or { name, ping } (FiveM).
export async function getGameStatus(game, opts = {}) {
  if (game?.kind === 'minecraft') return getMinecraftStatus(game);
  if (game?.kind === 'fivem') return getFivemStatus(game, opts);
  throw new Error(`unsupported game kind: ${game?.kind}`);
}

export async function runGameCommand(game, command) {
  if (game?.kind === 'minecraft') return runMinecraftCommand(game, command);
  if (game?.kind === 'fivem') {
    throw new Error('FiveM console + restart live in txAdmin — Mission Control shows the server read-only');
  }
  throw new Error(`unsupported game kind: ${game?.kind}`);
}
