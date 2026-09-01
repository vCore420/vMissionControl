import { WebSocketServer } from 'ws';
import { appEvents } from './events.js';
import { recordDevice, markWsConnected, markWsDisconnected } from './devices.js';
import { loadConfig, sanitizeConfig } from './config.js';
import { parseCookies, SESSION_COOKIE, isSessionValid, sessionMaxAgeMs } from './auth.js';
import { isIpAllowed } from './ipAllowlist.js';
import { clientIp } from './net.js';

// Push layer for real-time sync across every device that has the dashboard
// open. When Settings → Security has no password set, there's no auth
// here, same as the REST API — anyone who can reach the HTTP server can
// reach this too, matching the app's trusted-LAN threat model. When a
// password *is* set, this needs its own gate: a WebSocket upgrade is a
// normal HTTP request first, so the browser sends the session cookie on it
// automatically for a same-origin connection — so the upgrade handler runs
// the same isSessionValid() check as every REST route, not sit behind the
// REST API as an unauthenticated back door into the same live data.
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
      // A WebSocket upgrade is an ordinary HTTP request first, so the browser
      // sends the session cookie on it for a same-origin connection — which
      // lets this run the exact same check as every REST route (auth.js's
      // isSessionValid), not just look for the cookie's presence. Presence
      // alone was forgeable: any client that could reach the port could send
      // `Cookie: mc_session=anything` and receive the whole broadcast stream.
      // A stale token whose session has since expired is refused here too; an
      // already-open socket isn't torn down when its session later lapses
      // (the next reconnect fails, and it's a read-only feed either way).
      const token = parseCookies(req)[SESSION_COOKIE];
      if (!isSessionValid(token, sessionMaxAgeMs(config))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
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
  appEvents.on('chat:messageUpdated', ({ channelId, message }) =>
    broadcast({ type: 'chatMessageUpdated', channelId, message })
  );
  appEvents.on('chat:messageDeleted', ({ channelId, messageId }) =>
    broadcast({ type: 'chatMessageDeleted', channelId, messageId })
  );
  // Code tab — the session list (metadata only) plus the same
  // message / in-place-edit pair chat uses, so a streamed reply reads as
  // "typing" on every device at once (see codeStore.js / codeAgent.js).
  appEvents.on('code:sessions', ({ sessions }) => broadcast({ type: 'codeSessions', sessions }));
  appEvents.on('code:message', ({ sessionId, message }) => broadcast({ type: 'codeMessage', sessionId, message }));
  appEvents.on('code:messageUpdated', ({ sessionId, message }) =>
    broadcast({ type: 'codeMessageUpdated', sessionId, message })
  );
  appEvents.on('code:turn', ({ sessionId, running }) => broadcast({ type: 'codeTurn', sessionId, running }));
  // A background command (Code parity roadmap 2a) started, produced output, or
  // exited — the "running" strip refetches its list for that session.
  appEvents.on('code:background', ({ sessionId }) => broadcast({ type: 'codeBackground', sessionId }));
  appEvents.on('profile:updated', ({ deviceId, profile }) => broadcast({ type: 'profile', deviceId, profile }));
  // Generated-image events (creative roadmap Phase 1). 'art:progress' is
  // per-device — only the device that asked for a wallpaper wants the sampler
  // step count — but it's cheap to broadcast and the client filters on
  // deviceId. 'art:wallpapers' is the whole pool, re-sent whenever it changes
  // so every open Appearance panel stays current.
  appEvents.on('art:progress', (msg) => broadcast({ type: 'artProgress', ...msg }));
  appEvents.on('art:wallpapers', ({ wallpapers }) => broadcast({ type: 'artWallpapers', wallpapers }));
  // The Activity view's live feed (ops roadmap Phase 1) — every logActivity()
  // call, pushed so the timeline appends without a poll.
  appEvents.on('activity', (entry) => broadcast({ type: 'activity', entry }));
  // Only the profile + the live period, not the whole history — a second
  // open device needs to know what just changed, not get the full
  // multi-period archive re-sent on every keystroke-debounced save.
  appEvents.on('timesheet:update', (data) =>
    broadcast({ type: 'timesheet', profile: data.profile, period: data.periods[data.currentPeriodStart] })
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
