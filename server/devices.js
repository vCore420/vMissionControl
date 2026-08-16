// Tracks which devices (by IP) have talked to this server — every HTTP
// request and every WebSocket connection — so Settings can show a live
// traffic view. In-memory only, same ephemeral choice as everything else
// non-structural in this app (health history, chat messages): this is a
// monitoring aid, not itself the audit log (see activityLog.js for that;
// this module logs one line the first time a given IP is ever seen and
// leaves every subsequent request to activityLog's per-action entries,
// which already carry the acting IP).

import { logActivity } from './activityLog.js';

const MAX_DEVICES = 100;
const devices = new Map(); // ip -> device record

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  return ip.replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6 (::ffff:192.168.1.23) for clean display
}

function parseUserAgent(ua) {
  if (!ua) return 'Unknown device';

  let os = 'Unknown OS';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/iphone/i.test(ua)) os = 'iPhone';
  else if (/ipad/i.test(ua)) os = 'iPad';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/mac os x/i.test(ua)) os = 'Mac';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown browser';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/chrome\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';

  return `${browser} on ${os}`;
}

function evictOldestIfOverCap() {
  if (devices.size <= MAX_DEVICES) return;
  let oldest = null;
  for (const device of devices.values()) {
    if (!oldest || device.lastSeen < oldest.lastSeen) oldest = device;
  }
  if (oldest) devices.delete(oldest.ip);
}

export function recordDevice(rawIp, userAgent) {
  const ip = normalizeIp(rawIp);
  let device = devices.get(ip);
  const isNew = !device;
  if (!device) {
    device = {
      ip,
      userAgent: '',
      label: 'Unknown device',
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      requestCount: 0,
      wsConnections: 0,
    };
    devices.set(ip, device);
    evictOldestIfOverCap();
  }

  device.lastSeen = new Date().toISOString();
  device.requestCount += 1;
  if (userAgent) {
    device.userAgent = userAgent;
    device.label = parseUserAgent(userAgent);
  }
  if (isNew) logActivity('device', `New device seen: ${device.label}`, ip);
  return device;
}

export function markWsConnected(rawIp) {
  const device = devices.get(normalizeIp(rawIp));
  if (device) device.wsConnections += 1;
}

export function markWsDisconnected(rawIp) {
  const device = devices.get(normalizeIp(rawIp));
  if (device) device.wsConnections = Math.max(0, device.wsConnections - 1);
}

export function getDevices() {
  return [...devices.values()]
    .map((d) => ({ ...d, online: d.wsConnections > 0 }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

// Only prunes devices that aren't currently connected — clearing history
// shouldn't make an active connection appear to vanish and then reappear.
export function clearDevices() {
  for (const [ip, device] of devices) {
    if (device.wsConnections === 0) devices.delete(ip);
  }
}
