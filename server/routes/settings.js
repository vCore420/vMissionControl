import { Router } from 'express';
import fs from 'node:fs/promises';
import { loadConfig, saveConfig, resolveSharedFolderPath } from '../config.js';

export const settingsRouter = Router();

settingsRouter.put('/', async (req, res) => {
  const config = await loadConfig();
  const body = req.body;

  if (body.settings) {
    config.settings = {
      ...config.settings,
      healthCheckIntervalMs: body.settings.healthCheckIntervalMs ?? config.settings.healthCheckIntervalMs,
      healthCheckTimeoutMs: body.settings.healthCheckTimeoutMs ?? config.settings.healthCheckTimeoutMs,
      port: body.settings.port ?? config.settings.port,
    };
  }

  if (body.sharedFolder) {
    const next = { ...config.sharedFolder, ...body.sharedFolder };
    if (next.path !== config.sharedFolder.path) {
      const resolved = resolveSharedFolderPath({ sharedFolder: next });
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          return res.status(400).json({ error: 'path is not a directory' });
        }
      } catch {
        return res.status(400).json({ error: `path does not exist: ${resolved}` });
      }
    }
    config.sharedFolder = next;
  }

  await saveConfig(config);
  res.json({ settings: config.settings, sharedFolder: config.sharedFolder });
});
