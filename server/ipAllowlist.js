// Optional network-layer gate, off by default and independent of the
// password gate in auth.js — this rejects a request before it's even
// asked to log in. Meant for shrinking exposure on purpose (e.g. "only
// Tailscale's CGNAT range may reach this at all"), not as the primary
// defense; auth.js is still what actually identifies who's asking.

import { loadConfig } from './config.js';
import { clientIp } from './net.js';
import { logActivity } from './activityLog.js';

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return parts.reduce((acc, o) => (acc << 8) + o, 0) >>> 0;
}

export function isValidCidr(cidr) {
  const [range, bitsStr] = cidr.split('/');
  if (ipToInt(range) === null) return false;
  if (bitsStr === undefined) return true; // bare IP, treated as /32
  const bits = Number(bitsStr);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32;
}

function ipInCidr(ip, cidr) {
  const ipInt = ipToInt(ip);
  const [range, bitsStr] = cidr.split('/');
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function normalizeIp(ip) {
  return ip?.replace(/^::ffff:/, '') || '';
}

export function isIpAllowed(config, rawIp) {
  const list = config.security?.ipAllowlist;
  if (!list?.enabled || !list.subnets?.length) return true;

  const ip = normalizeIp(rawIp);
  // Loopback is always allowed regardless of the configured list — an
  // allowlist that forgets to include 127.0.0.1 would otherwise lock out
  // the very machine running the server, with no way back in short of
  // hand-editing config.json.
  if (ip === '127.0.0.1' || ip === '::1') return true;

  return list.subnets.some((cidr) => {
    try {
      return ipInCidr(ip, cidr);
    } catch {
      return false;
    }
  });
}

export async function requireIpAllowlist(req, res, next) {
  const config = await loadConfig();
  const ip = clientIp(req);
  if (isIpAllowed(config, ip)) return next();
  logActivity('security', `Blocked request from disallowed IP`, ip);
  res.status(403).type('text/plain').send('Access denied.');
}
