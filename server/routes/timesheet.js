import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import {
  loadTimesheet,
  saveProfile,
  switchPeriod,
  saveCurrentEntries,
  resetCurrentPeriod,
  listPastPeriods,
  getPeriod,
  setPeriodImage,
  IMAGE_DIR,
} from '../timesheet.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const timesheetRouter = Router();

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Guards the two shapes a period date shows up in: as a URL param
// (:periodStart) or as a body field (period-start's switch target).
function requireValidPeriodParam(req, res, next) {
  if (!PERIOD_RE.test(req.params.periodStart)) return res.status(400).json({ error: 'invalid period date' });
  next();
}
function requireValidPeriodBody(req, res, next) {
  if (!PERIOD_RE.test(req.body.periodStart || '')) return res.status(400).json({ error: 'invalid period date' });
  next();
}

timesheetRouter.get('/', async (req, res) => {
  const data = await loadTimesheet();
  res.json({ profile: data.profile, period: data.periods[data.currentPeriodStart] });
});

timesheetRouter.put('/profile', async (req, res) => {
  const { name, defaultStart, defaultFinish, defaultLunch } = req.body;
  const fields = {};
  if (typeof name === 'string') fields.name = name.slice(0, 80);
  if (typeof defaultStart === 'string') fields.defaultStart = defaultStart;
  if (typeof defaultFinish === 'string') fields.defaultFinish = defaultFinish;
  if (typeof defaultLunch === 'number') fields.defaultLunch = defaultLunch;
  const data = await saveProfile(fields);
  res.json({ profile: data.profile });
});

// Deliberate, explicit switch (mirrors the standalone tool's "Current
// fortnight starts" field) — distinct from the lazy day-based rollover
// that loadTimesheet() runs on every call, which only ever advances along
// the existing anchor's own cadence rather than jumping to an arbitrary
// period.
timesheetRouter.put('/period-start', requireValidPeriodBody, async (req, res) => {
  const data = await switchPeriod(req.body.periodStart);
  res.json({ period: data.periods[data.currentPeriodStart] });
});

timesheetRouter.put('/entries', async (req, res) => {
  const { weeks, entries } = req.body;
  const data = await saveCurrentEntries({ weeks, entries });
  res.json({ period: data.periods[data.currentPeriodStart] });
});

timesheetRouter.post('/reset', async (req, res) => {
  const data = await resetCurrentPeriod();
  logActivity('timesheet', 'Cleared current fortnight', clientIp(req));
  res.json({ period: data.periods[data.currentPeriodStart] });
});

timesheetRouter.get('/periods', async (req, res) => {
  const periods = await listPastPeriods();
  res.json({
    periods: periods.map((p) => ({ periodStart: p.periodStart, completed: p.completed, hasImage: !!p.imageFilename })),
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await fs.mkdir(IMAGE_DIR, { recursive: true });
        cb(null, IMAGE_DIR);
      } catch (err) {
        cb(err);
      }
    },
    // One image per period, named directly after its already-validated
    // periodStart — a natural, collision-free key, unlike chat's
    // attachments which need a generated name since many can share a
    // channel.
    filename: (req, file, cb) => cb(null, `${req.params.periodStart}.png`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'image/png'),
});

timesheetRouter.post('/periods/:periodStart/image', requireValidPeriodParam, async (req, res) => {
  const period = await getPeriod(req.params.periodStart);
  if (!period) return res.status(404).json({ error: 'period not found' });

  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no image provided' });
    await setPeriodImage(req.params.periodStart, req.file.filename);
    res.status(201).json({ ok: true });
  });
});

timesheetRouter.get('/periods/:periodStart/image', requireValidPeriodParam, async (req, res) => {
  const period = await getPeriod(req.params.periodStart);
  if (!period?.imageFilename) return res.status(404).json({ error: 'no image saved for this period' });
  try {
    await fs.access(path.join(IMAGE_DIR, period.imageFilename));
    res.sendFile(path.join(IMAGE_DIR, period.imageFilename));
  } catch {
    res.status(404).json({ error: 'image file missing on disk' });
  }
});
