import os from 'node:os';
import { peekConfig } from './config.js';

// The requesting client's IP.
//
// By default this is req.socket.remoteAddress — the real TCP peer, which a
// client can't forge without control of the network path. X-Forwarded-For is
// only consulted when config.settings.trustProxy is on, because otherwise any
// client could set that header itself and spoof its address past the login
// rate-limiter (auth.js) and the IP allowlist (ipAllowlist.js) — both of which
// key on this value. Turn trustProxy on only when a known reverse proxy
// (nginx, Caddy, `tailscale serve`) actually sets the header.
//
// Shared by index.js (device tracking), ws.js (WebSocket connection
// tracking), auth.js (login rate limiting), and the activity log.
export function clientIp(req) {
  if (peekConfig()?.settings?.trustProxy) {
    const forwarded = req.headers['x-forwarded-for']?.split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress;
}

// This host's own non-internal IPv4 addresses — printed at startup
// (index.js) so you know where to point a browser, and shown again in
// Host Health (host.js) so that's reachable without checking the console.
export function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}
