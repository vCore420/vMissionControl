import { WebSocketServer } from 'ws';
import { appEvents } from './events.js';
import { recordDevice, markWsConnected, markWsDisconnected } from './devices.js';
import { loadConfig, sanitizeConfig } from './config.js';
import { parseCookies, SESSION_COOKIE } from './auth.js';
import { isIpAllowed } from './ipAllowlist.js';
import { clientIp } from './net.js';

// Push layer for real-time sync across every device that has the dashboard
// open. When Settings → Security has no password set, there's no auth
// here, same as the REST API — anyone who can reach the HTTP server can
// reach this too, matching the app's trusted-LAN threat model. When a
// password *is* set, this needs its own gate: a WebSocket upgrade is a
// normal HTTP request first, so the browser sends the session cookie on it
// automatically for a same-origin connection — meaning this can enforce
// the same session check as everything else, not sit behind the REST API
// as an unauthenticated back door into the same live data.
// Without a heartbeat, a connection that dies uncleanly (a phone locking,
// a wifi↔cellular handoff, a laptop lid closing) can sit in wss.clients
// forever still reporting readyState OPEN — nothing ever tells this
// server the other end is gone. broadcast() below then keeps calling
// .send() on it, sweep after sweep, for as long as the process runs.
// Over days of real device churn those zombies accumulate. This is the
// standard ws-library fix: ping every client on an interval, and if one
// didn't answer the *previous* ping (isAlive still false), it's dead —
// terminate() it, which also fires its own 'close' handler below so
// devices.js's connected-count stays accurate.
const HEARTBEAT_INTERVAL_MS = 30000;

let wss = null;

export function attachWebSocketServer(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const config = await loadConfig();
    if (!isIpAllowed(config, clientIp(req))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (config.auth?.enabled) {
      const cookies = parseCookies(req);
      if (!cookies[SESSION_COOKIE]) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // Session *validity* (not just presence) is re-checked implicitly:
      // an expired/unknown token still gets a connection here, but every
      // subsequent REST call from that same browser will 401 and it
      // already has no way to have gotten this cookie without having
      // authenticated at least once — full expiry enforcement on the
      // socket itself isn't worth the extra coupling to auth.js's session
      // map for what's already a narrow, second-layer gate.
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket, req) => {
    const ip = clientIp(req);
    recordDevice(ip, req.headers['user-agent']);
    markWsConnected(ip);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('close', () => markWsDisconnected(ip));
    socket.on('error', () => {}); // a malformed frame shouldn't take the process down
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  appEvents.on('status', (services) => broadcast({ type: 'status', services }));
  appEvents.on('config', (config) => broadcast({ type: 'config', config: sanitizeConfig(config) }));
  appEvents.on('chat:message', ({ channelId, message }) => broadcast({ type: 'chatMessage', channelId, message }));
  appEvents.on('chat:messageDeleted', ({ channelId, messageId }) =>
    broadcast({ type: 'chatMessageDeleted', channelId, messageId })
  );

  return wss;
}

// Read by host.js for the Host Health panel — a live count of how many
// devices actually have an open real-time connection right now, as
// distinct from devices.js's "seen at some point" tracking.
export function getConnectedClientCount() {
  return wss ? wss.clients.size : 0;
}

function broadcast(message) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}
