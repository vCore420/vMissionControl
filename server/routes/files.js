import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { loadConfig, resolveSharedFolderPath } from '../config.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';
import { planZip, streamPlannedZip, ZipTooLargeError } from '../zip.js';
import { searchSharedFolder, recordUpload, getRecentUploads } from '../fileShare.js';

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

// Zips a folder on the fly and streams it straight into the response —
// see server/zip.js for why this is hand-rolled instead of a dependency.
// planZip walks the tree and enforces the size cap *before* any response
// headers go out, so an oversized folder still comes back as a normal
// JSON error instead of a broken download. A failure once streaming has
// actually started has no clean way to become a different HTTP status
// (the 200 is already committed), so that case just tears the connection
// down — the client sees a failed/truncated download rather than
// silently getting a corrupt one.
filesRouter.get('/download-zip', async (req, res) => {
  let target;
  try {
    target = await safeResolve(req.mcConfig, req.query.path);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a folder' });
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    return res.status(404).json({ error: 'folder not found' });
  }

  const folderName = path.basename(target) || 'shared';
  try {
    const { entries } = await planZip(target);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
    });
    await streamPlannedZip(res, entries);
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
    } else if (err instanceof ZipTooLargeError) {
      res.status(413).json({ error: err.message });
    } else {
      res.status(500).json({ error: err.message });
    }
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

// Recursive, case-insensitive filename search across the whole shared tree
// — see server/fileShare.js for the implementation (shared with the
// assistant's search_shared_folder tool) and the two caps it enforces.
filesRouter.get('/search', async (req, res) => {
  res.json(await searchSharedFolder(req.mcConfig, req.query.q));
});

// Rename and move are the same operation (fs.rename) — "rename" is just a
// move within the same folder, so one endpoint covers both rather than
// keeping two near-identical handlers in sync. Refuses to clobber an
// existing file/folder at the destination rather than silently
// overwriting it.
filesRouter.post('/move', async (req, res) => {
  const config = req.mcConfig;
  try {
    const from = await safeResolve(config, req.body.from);
    const to = await safeResolve(config, req.body.to);
    if (from === to) return res.status(400).json({ error: 'source and destination are the same' });
    const alreadyExists = await fs.access(to).then(() => true).catch(() => false);
    if (alreadyExists) return res.status(400).json({ error: 'something already exists at the destination' });
    await fs.rename(from, to);
    logActivity('file', `Moved "${req.body.from}" → "${req.body.to}"`, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PathError) return res.status(400).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// Last N uploads, newest first — in-memory, ephemeral like chat history /
// device tracking / host stats (see server/fileShare.js, shared with the
// assistant's get_recent_uploads tool).
filesRouter.get('/recent', (req, res) => {
  res.json({ items: getRecentUploads() });
});

// Disk storage (streamed straight to its final destination) instead of
// buffering the whole upload in memory first — the old memoryStorage
// approach held the entire file in RAM before ever touching disk, which
// is a real problem once uploads include video/music instead of just
// small config-style files.
// A whole-folder upload sends each file's path *within* the folder being
// uploaded (e.g. "Vacation2026/beach.jpg", from the browser's own
// File.webkitRelativePath) as a `relPath` form field placed ahead of the
// file field — multer only has it in req.body by the time these callbacks
// run if the client appended it to the FormData before the file, since a
// multipart body is parsed in stream order. Falls back to the plain
// filename when relPath isn't sent, so a normal single/multi-file upload
// (no relPath) behaves exactly as it did before this existed.
// destination() stashes the resolved full relative path on req so both
// filename() and the route handler below reuse the same value instead of
// three slightly-different recomputations of it.
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const config = await loadConfig();
        const relPath = typeof req.body?.relPath === 'string' && req.body.relPath ? req.body.relPath : path.basename(file.originalname);
        req.mcUploadRelPath = req.query.path ? `${req.query.path}/${relPath}` : relPath;
        const subDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
        const dirRelPath = req.query.path ? `${req.query.path}${subDir ? '/' + subDir : ''}` : subDir;
        const dir = await safeResolve(config, dirRelPath);
        // multer's diskStorage expects this directory to already exist —
        // it never creates intermediate folders itself, which a plain
        // single-file upload never needed since it always lands in a
        // folder the user is already looking at.
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const relPath = typeof req.body?.relPath === 'string' && req.body.relPath ? req.body.relPath : file.originalname;
      cb(null, path.basename(relPath));
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

// Checked *before* multer's disk-writing middleware runs, not after —
// with the old memoryStorage this check could safely happen after upload
// since nothing had touched disk yet, but diskStorage writes the file
// during the multer middleware itself, so rejecting afterward would mean
// a disallowed upload still landed on disk first.
function requireUploadAllowed(req, res, next) {
  if (!req.mcConfig.sharedFolder.allowUpload) {
    return res.status(403).json({ error: 'upload is disabled in settings' });
  }
  next();
}

filesRouter.post('/upload', requireUploadAllowed, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file provided' });

  const name = req.file.filename;
  const relPath = req.mcUploadRelPath || (req.query.path ? `${req.query.path}/${name}` : name);
  recordUpload(relPath, name, req.file.size);
  logActivity('file', `Uploaded "${relPath}"`, clientIp(req));
  res.status(201).json({ ok: true, name });
});
