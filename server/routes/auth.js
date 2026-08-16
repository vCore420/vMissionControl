import { Router } from 'express';
import { loadConfig } from '../config.js';
import { clientIp } from '../net.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  setPassword,
  disableAuth,
  setSessionDays,
  sessionMaxAgeMs,
} from '../auth.js';
import { logActivity } from '../activityLog.js';

export const authRouter = Router();

// Public — the frontend needs to know whether to show a login prompt (or,
// in Settings, whether protection is currently on) without a session.
authRouter.get('/status', async (req, res) => {
  const config = await loadConfig();
  const cookies = parseCookies(req);
  res.json({
    enabled: !!config.auth?.enabled,
    authenticated: !config.auth?.enabled || !!cookies[SESSION_COOKIE],
  });
});

authRouter.post('/login', async (req, res) => {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    logActivity('auth', 'Login blocked (rate-limited)', ip);
    return res.status(429).json({ error: 'too many attempts — try again in a few minutes' });
  }

  const config = await loadConfig();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!config.auth?.enabled || !verifyPassword(password, config.auth)) {
    recordFailedAttempt(ip);
    logActivity('auth', 'Login failed (wrong password)', ip);
    return res.status(401).json({ error: 'incorrect password' });
  }

  clearFailedAttempts(ip);
  setSessionCookie(res, createSession(), sessionMaxAgeMs(config));
  logActivity('auth', 'Signed in', ip);
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) destroySession(token);
  clearSessionCookie(res);
  logActivity('auth', 'Signed out', clientIp(req));
  res.json({ ok: true });
});

// Setting a password only ever needs the *current* request to already be
// authorized to reach Settings at all — which requireAuth has already
// guaranteed by the time this handler runs (either auth is currently off,
// so Settings itself is unauthenticated the same as everything else today,
// or the caller already has a valid session). No separate "old password"
// check on top of that.
authRouter.post('/password', async (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const wasEnabled = (await loadConfig()).auth?.enabled;
  await setPassword(password);
  // Log the setter straight in so turning protection on doesn't
  // immediately lock the person who just enabled it out of their own app.
  clearFailedAttempts(clientIp(req));
  const config = await loadConfig();
  setSessionCookie(res, createSession(), sessionMaxAgeMs(config));
  logActivity('auth', wasEnabled ? 'Password changed' : 'Password protection enabled', clientIp(req));
  res.json({ ok: true });
});

authRouter.post('/disable', async (req, res) => {
  await disableAuth();
  clearSessionCookie(res);
  logActivity('auth', 'Password protection disabled', clientIp(req));
  res.json({ ok: true });
});

// Independent of setting/changing the password — lets you adjust how long
// a session stays alive without re-entering it. Takes effect immediately
// for every existing session (see auth.js's touchSession), not just new
// ones.
authRouter.post('/session-length', async (req, res) => {
  const days = Number(req.body?.days);
  try {
    await setSessionDays(days);
    logActivity('auth', `Session length set to ${days} day${days === 1 ? '' : 's'}`, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
