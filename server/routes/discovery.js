import { Router } from 'express';
import { startScan, getScanState, cancelScan } from '../discovery.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const discoveryRouter = Router();

discoveryRouter.get('/', (req, res) => {
  res.json(getScanState());
});

discoveryRouter.post('/', (req, res) => {
  const state = startScan();
  if (state.running) logActivity('discovery', 'Started network scan', clientIp(req));
  res.json(state);
});

discoveryRouter.delete('/', (req, res) => {
  res.json(cancelScan());
});
