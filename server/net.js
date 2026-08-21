import os from 'node:os';

// Trusted-LAN app behind no proxy by default, but honor X-Forwarded-For if
// something's fronting it rather than mislabeling every device as the
// proxy's own address. Shared by index.js (device tracking), ws.js
// (WebSocket connection tracking), and auth.js (login rate limiting) —
// pulled out once these were three separate near-identical copies.
export function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
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
