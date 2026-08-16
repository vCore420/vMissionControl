import { Router } from 'express';
import { getDevices, clearDevices } from '../devices.js';

export const devicesRouter = Router();

devicesRouter.get('/', (req, res) => {
  res.json({ devices: getDevices() });
});

// Prunes history for devices that aren't currently connected — see
// clearDevices() in devices.js for why active connections are spared.
devicesRouter.delete('/', (req, res) => {
  clearDevices();
  res.status(204).end();
});
