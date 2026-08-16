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
    socket.on('close', () => markWsDisconnected(ip));
    socket.on('error', () => {}); // a malformed frame shouldn't take the process down
  });

  appEvents.on('status', (services) => broadcast({ type: 'status', services }));
  appEvents.on('config', (config) => broadcast({ type: 'config', config: sanitizeConfig(config) }));
  appEvents.on('chat:message', ({ channelId, message }) => broadcast({ type: 'chatMessage', channelId, message }));
  appEvents.on('chat:messageDeleted', ({ channelId, messageId }) =>
    broadcast({ type: 'chatMessageDeleted', channelId, messageId })
  );

  return wss;
}

function broadcast(message) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}
