// Ops roadmap, Phase 1 — the Activity view's data. One GET over
// activityLog.js#readRecentActivity, newest-first, with search + a `before`
// cursor for "load older". Just the app's normal session — the log carries
// IPs and every action taken, so it sits behind the password gate when one
// is set (like every other /api route).

import { Router } from 'express';
import { readRecentActivity } from '../activityLog.js';

export const activityRouter = Router();

const HOURS = new Set([1, 6, 24, 168, 720]); // 1h / 6h / day / week / month

activityRouter.get('/', async (req, res) => {
  const sinceHours = HOURS.has(Number(req.query.hours)) ? Number(req.query.hours) : 24;
  const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : null;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim().slice(0, 100) : null;
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));

  const entries = await readRecentActivity({ sinceHours, category, search, before, limit, newestFirst: true });
  res.json({ entries, hasMore: entries.length === limit });
});
