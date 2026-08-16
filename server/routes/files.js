import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { loadConfig, resolveSharedFolderPath } from '../config.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const filesRouter = Router();

class PathError extends Error {}

// Resolves a client-supplied relative path against the shared folder root
// and rejects anything that would escape it (../, absolute paths, symlinked
// escapes are not followed here since we only resolve the string).
async function safeResolve(config, relPath) {
  const root = resolveSharedFolderPath(config);
  const target = path.resolve(root, '.' + path.sep + (relPath || ''));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new PathError('path escapes shared folder');
  }
  return target;
}

async function requireEnabled(req, res, next) {
  const config = await loadConfig();
  if (!config.sharedFolder.enabled) {
    return res.status(403).json({ error: 'shared folder is disabled' });
  }
  req.mcConfig = config;
  next();
}

filesRouter.use(requireEnabled);

filesRouter.get('/', async (req, res) => {
  try {
    const target = await safeResolve(req.mcConfig, req.query.path);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(target, entry.name);
        const stat = await fs.stat(full).catch(() => null);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size: stat?.size ?? null,
          modified: stat?.mtime ?? null,
        };
      })
    );
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: req.query.path || '', items });
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    res.status(404).json({ error: 'directory not found' });
  }
});

filesRouter.get('/download', async (req, res) => {
  try {
    const target = await safeResolve(req.mcConfig, req.query.path);
    res.download(target);
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    res.status(404).json({ error: 'file not found' });
  }
});

filesRouter.post('/mkdir', async (req, res) => {
  try {
    const target = await safeResolve(req.mcConfig, req.body.path);
    await fs.mkdir(target, { recursive: false });
    logActivity('file', `Created folder "${req.body.path}"`, clientIp(req));
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

filesRouter.delete('/', async (req, res) => {
  const config = req.mcConfig;
  if (!config.sharedFolder.allowDelete) {
    return res.status(403).json({ error: 'delete is disabled in settings' });
  }
  try {
    const target = await safeResolve(config, req.query.path);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      await fs.rmdir(target);
    } else {
      await fs.unlink(target);
    }
    logActivity('file', `Deleted "${req.query.path}"`, clientIp(req));
    res.status(204).end();
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

filesRouter.post('/upload', upload.single('file'), async (req, res) => {
  const config = req.mcConfig;
  if (!config.sharedFolder.allowUpload) {
    return res.status(403).json({ error: 'upload is disabled in settings' });
  }
  if (!req.file) return res.status(400).json({ error: 'no file provided' });

  try {
    const destDir = await safeResolve(config, req.query.path);
    const destFile = path.join(destDir, path.basename(req.file.originalname));
    const rootWithSep = destDir.endsWith(path.sep) ? destDir : destDir + path.sep;
    if (!destFile.startsWith(rootWithSep)) throw new PathError('invalid filename');
    await fs.writeFile(destFile, req.file.buffer);
    logActivity('file', `Uploaded "${path.basename(destFile)}"`, clientIp(req));
    res.status(201).json({ ok: true, name: path.basename(destFile) });
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});
