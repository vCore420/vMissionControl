// Trusted-LAN app behind no proxy by default, but honor X-Forwarded-For if
// something's fronting it rather than mislabeling every device as the
// proxy's own address. Shared by index.js (device tracking), ws.js
// (WebSocket connection tracking), and auth.js (login rate limiting) —
// pulled out once these were three separate near-identical copies.
export function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}
