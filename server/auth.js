// Optional single-passphrase gate for the whole app. Off by default — the
// app's original trusted-LAN model still works unchanged when auth.enabled
// is false. Built entirely on Node's built-in crypto (scrypt for hashing,
// timingSafeEqual for comparison, randomBytes for salts/session tokens) and
// a manual cookie parser, so this adds zero new dependencies.
//
// This is deliberately a doorlock, not a user-account system: one shared
// passphrase, one session type. That matches who actually uses this app —
// see docs/README's Security note for the threat model this is answering
// (a breached Tailscale node or LAN, not multi-tenant access control).

import crypto from 'node:crypto';
import { loadConfig, saveConfig } from './config.js';

const SESSION_COOKIE = 'mc_session';
const DEFAULT_SESSION_DAYS = 30;
const MIN_SESSION_DAYS = 1;
const MAX_SESSION_DAYS = 365;
const SCRYPT_KEYLEN = 64;

// Configurable per-install (Settings → Security), sliding — see
// touchSession. Clamped defensively even though the route validates it too,
// since a stale/hand-edited config.json could otherwise carry a bad value.
export function sessionMaxAgeMs(config) {
  const days = Math.min(MAX_SESSION_DAYS, Math.max(MIN_SESSION_DAYS, config.auth?.sessionDays || DEFAULT_SESSION_DAYS));
  return days * 24 * 60 * 60 * 1000;
}

const sessions = new Map(); // token -> { createdAt, lastSeen }
const failedAttempts = new Map(); // ip -> { count, firstAttemptAt }

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

export function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

export function verifyPassword(password, { salt, hash }) {
  if (!salt || !hash) return false;
  const candidate = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
}

// Read by host.js for the Host Health panel. Expired-but-not-yet-touched
// sessions are only pruned lazily (the next time that exact token is
// checked, in touchSession above), so this can run slightly high rather
// than reflect the true live count — fine for a rough diagnostic, not
// worth a sweep of its own just to keep this number exact.
export function getActiveSessionCount() {
  return sessions.size;
}

// Sliding expiry: any authenticated request pushes the session's expiry
// back out, so a session used regularly never logs you out, but one
// abandoned for longer than the configured session length quietly stops
// working. maxAgeMs is passed in per-call (rather than read from a module
// constant) so a session-length change in Settings takes effect on the
// very next request, not just for sessions created afterward.
function touchSession(token, maxAgeMs) {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.lastSeen > maxAgeMs) {
    sessions.delete(token);
    return false;
  }
  session.lastSeen = Date.now();
  return true;
}

// Read-only "is this token a live session?" check, used by GET
// /api/auth/status. Deliberately does NOT slide the expiry the way
// touchSession does — the login page polls this before the user has done
// anything that should count as activity, and a status probe keeping a
// session alive would be a surprising side effect. Matches requireAuth's
// verdict so the two auth checks can't disagree: before this existed,
// /status trusted mere cookie *presence*, so a stale cookie left over
// after a server restart (in-memory `sessions` wiped, cookie still in the
// browser) made /status report "authenticated" while requireAuth kept
// redirecting to /login.html — an infinite bounce between / and
// /login.html that no device could log in through.
export function isSessionValid(token, maxAgeMs) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.lastSeen > maxAgeMs) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function isRateLimited(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return record.count >= RATE_LIMIT_MAX_ATTEMPTS;
}

export function recordFailedAttempt(ip) {
  const record = failedAttempts.get(ip);
  if (!record || Date.now() - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAttemptAt: Date.now() });
  } else {
    record.count += 1;
  }
}

export function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

function setSessionCookie(res, token, maxAgeMs) {
  // No `Secure` flag: this app is normally reached over plain HTTP on a
  // LAN/Tailscale address, not HTTPS (see README) — requiring Secure would
  // make the cookie never get sent at all in the app's actual deployment.
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export { SESSION_COOKIE, setSessionCookie, clearSessionCookie };

// Paths reachable with no session even while auth is enabled — just enough
// to render the login page and let it submit a password. Everything else,
// including every other static asset and every other API route, is gated.
const PUBLIC_EXACT_PATHS = new Set([
  '/login.html',
  '/css/style.css',
  '/js/login.js',
  '/manifest.webmanifest',
  '/service-worker.js',
  '/api/auth/login',
  '/api/auth/status',
]);
const PUBLIC_PREFIXES = ['/icons/'];

function isPublicPath(pathname) {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function requireAuth(req, res, next) {
  const config = await loadConfig();
  if (!config.auth?.enabled) return next();
  if (isPublicPath(req.path)) return next();

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token && touchSession(token, sessionMaxAgeMs(config))) {
    req.sessionToken = token;
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'authentication required' });
  }
  res.redirect(302, '/login.html');
}

// SameSite=Strict on the session cookie already blocks it from riding
// along on a cross-site request, but this adds a second, independent layer
// for free: a foreign origin's page can't attach a custom header to a
// fetch against this server without triggering a CORS preflight, and this
// server doesn't grant any cross-origin permissions — so a request missing
// this header either isn't a browser fetch from this app's own frontend,
// or is cross-site and got blocked before it arrived. Only enforced once
// there's actually a session to protect; with auth off there's no ambient
// credential for CSRF to ride on in the first place.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function requireCsrfHeader(req, res, next) {
  const config = await loadConfig();
  if (!config.auth?.enabled) return next();
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (isPublicPath(req.path)) return next();
  if (req.headers['x-mc-request'] !== '1') {
    return res.status(403).json({ error: 'missing CSRF header' });
  }
  next();
}

export async function setPassword(password) {
  const config = await loadConfig();
  const sessionDays = config.auth?.sessionDays ?? DEFAULT_SESSION_DAYS;
  config.auth = { enabled: true, sessionDays, ...createPasswordRecord(password) };
  await saveConfig(config);
}

export async function disableAuth() {
  const config = await loadConfig();
  const sessionDays = config.auth?.sessionDays ?? DEFAULT_SESSION_DAYS;
  config.auth = { enabled: false, sessionDays, salt: '', hash: '' };
  await saveConfig(config);
  sessions.clear();
}

export async function setSessionDays(days) {
  if (!Number.isFinite(days) || days < MIN_SESSION_DAYS || days > MAX_SESSION_DAYS) {
    throw new Error(`session length must be between ${MIN_SESSION_DAYS} and ${MAX_SESSION_DAYS} days`);
  }
  const config = await loadConfig();
  config.auth = { ...config.auth, sessionDays: days };
  await saveConfig(config);
}

export { DEFAULT_SESSION_DAYS, MIN_SESSION_DAYS, MAX_SESSION_DAYS };
