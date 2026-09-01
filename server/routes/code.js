import { Router } from 'express';
import { loadConfig } from '../config.js';
import {
  listSessions, getSession, getMessages, createSession, updateSession, deleteSession, addMessage, updateMessage,
} from '../codeStore.js';
import { runTurn, stopTurn, isBusy, decideApproval, answerQuestion } from '../codeAgent.js';
import { listBackground, stopBackground, stopSessionBackground } from '../codeBackground.js';
import { revertCheckpoint, dropSessionCheckpoints } from '../codeCheckpoints.js';
import { processMentions } from '../codeMentions.js';
import { listCommands, resolveCommand } from '../codeCommands.js';
import { parseImageAttachments, saveImages, dropSessionImages, imageFilePath } from '../codeImages.js';
import { OPTIONAL_TOOL_INFO, listWorkspaceFiles } from '../codeTools.js';
import { DEFAULT_DENY } from '../codeCommandRules.js';
import { processAttachments } from '../codeAttach.js';
import { showModel } from '../ollama.js';
import {
  listDir, readFile, resolveWorkspacePath, safeResolve, createContextFile,
  readContextFile, contextFileRel, readMemoryFile, memoryFileRel, appendToMemoryFile,
  WorkspacePathError,
} from '../codeWorkspace.js';
import { planZip, streamPlannedZip, ZipTooLargeError } from '../zip.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';
import path from 'node:path';
import fs from 'node:fs/promises';

export const codeRouter = Router();

// The coding agent writes files and runs commands on the host, so — exactly
// like service control — it needs BOTH its own switch and password
// protection, checked at request time. If auth is turned off later the
// feature stops working too (mirrors serviceControl.js#controlService).
codeRouter.use(async (req, res, next) => {
  const config = await loadConfig();
  if (!config.code?.enabled) {
    return res.status(403).json({ error: 'the Code feature is off — turn it on in Settings → Code' });
  }
  if (!config.auth?.enabled) {
    return res.status(403).json({ error: 'the Code feature needs password protection enabled first (Settings → Security)' });
  }
  req.mcConfig = config;
  next();
});

// ---------- Sessions (durable — see codeStore.js) ----------

codeRouter.get('/sessions', async (req, res) => {
  const sessions = await listSessions();
  // `running` seeds the sidebar "working" markers on first load — after that
  // the code:turn WS events keep them current.
  res.json({ sessions, running: sessions.filter((s) => isBusy(s.id)).map((s) => s.id) });
});

codeRouter.post('/sessions', async (req, res) => {
  const { code } = req.mcConfig;
  const session = await createSession({
    title: req.body?.title,
    model: req.body?.model ?? code.defaultModel,
    approvalMode: req.body?.approvalMode ?? code.defaultApprovalMode,
  });
  logActivity('settings', `Code session created: "${session.title}"`, clientIp(req));
  res.status(201).json(session);
});

codeRouter.put('/sessions/:id', async (req, res) => {
  const session = await updateSession(req.params.id, req.body || {});
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
});

codeRouter.delete('/sessions/:id', async (req, res) => {
  // Kill any background commands this session started before the session
  // itself goes away — otherwise they'd run on, orphaned, until the age cap.
  stopSessionBackground(req.params.id);
  dropSessionCheckpoints(req.params.id); // and its per-turn revert snapshots (2c)
  dropSessionImages(req.params.id); // and any attached-image files (4b)
  const ok = await deleteSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'session not found' });
  logActivity('settings', 'Code session deleted', clientIp(req));
  res.status(204).end();
});

// ---------- Background commands (Code parity roadmap 2a — see codeBackground.js) ----------

// The Code view's "running" strip polls this while the view is open.
codeRouter.get('/sessions/:id/background', async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({ background: listBackground(req.params.id) });
});

// The human's Stop button on a running process (the agent uses the
// stop_command tool, which goes through the same codeBackground path).
codeRouter.post('/background/:bgId/stop', async (req, res) => {
  const result = stopBackground(req.params.bgId);
  if (result.error) return res.status(404).json(result);
  logActivity('code', `Stopped a background command (${result.command || req.params.bgId})`, clientIp(req));
  res.json({ ok: true, ...result });
});

// ---------- Messages ----------

codeRouter.get('/sessions/:id/messages', async (req, res) => {
  const messages = await getMessages(req.params.id);
  if (messages === null) return res.status(404).json({ error: 'session not found' });
  res.json({ messages });
});

codeRouter.post('/sessions/:id/messages', async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (isBusy(req.params.id)) return res.status(409).json({ error: 'this session is already working on a reply' });

  const text = (req.body?.text || '').trim();
  if (text.length > 20000) return res.status(400).json({ error: 'message is too long (max 20000 characters)' });

  // Attachments (Phase 9): text spliced onto this turn only; `stored` is the
  // chip metadata kept on the message, `forPrompt` carries the text.
  const { stored, forPrompt } = processAttachments(req.body?.attachments);
  // @file mentions (Code parity roadmap 3a): workspace paths from the composer's
  // picker, read server-side and spliced onto this turn the same way.
  const { stored: mentionsStored, forPrompt: mentionsForPrompt } = await processMentions(
    req.mcConfig,
    req.body?.mentions
  );
  // Image attachments (Code parity roadmap 4a): decoded here, described by the
  // vision model in runTurn, spliced onto the turn as text.
  const { stored: imagesStored, forVision } = parseImageAttachments(req.body?.images);
  if (!text && !stored.length && !mentionsStored.length && !imagesStored.length) {
    return res.status(400).json({ error: 'a message needs text, an attachment, an @file, or an image' });
  }

  // Custom /commands (Code parity roadmap 3b): `/name args` → expand the
  // template from .mc/commands/<name>.md (or a built-in). The raw `/name args`
  // stays as the message text (that's what the transcript shows); the expanded
  // prompt + any model/approvalMode overrides go to runTurn for this turn only.
  let commandPrompt = null;
  let commandMeta = null;
  const overrides = {};
  const slash = /^\/([A-Za-z0-9][\w-]*)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (slash) {
    const cmd = await resolveCommand(req.mcConfig, slash[1], slash[2] || '');
    if (!cmd) {
      return res.status(400).json({
        error: `no /${slash[1].toLowerCase()} command — add one as .mc/commands/${slash[1].toLowerCase()}.md, or use /review /test /explain`,
      });
    }
    commandPrompt = cmd.prompt;
    commandMeta = { name: cmd.name, source: cmd.source };
    if (cmd.model) overrides.model = cmd.model;
    if (cmd.approvalMode) overrides.approvalMode = cmd.approvalMode;
  }

  const author = (req.body?.author || 'Anonymous').trim().slice(0, 40);
  const deviceId = (req.get('X-Mc-Device') || '').slice(0, 64) || undefined;
  const message = await addMessage(req.params.id, {
    role: 'user', author, deviceId, text,
    attachments: stored, mentions: mentionsStored, images: imagesStored, command: commandMeta,
  });

  // Persist the images to disk (4b) so the transcript can still show them, and
  // patch the file refs back onto the message.
  if (forVision.length) {
    const saved = await saveImages(req.params.id, message.id, forVision);
    await updateMessage(req.params.id, message.id, { images: saved }, { persist: true });
    message.images = saved;
  }

  // Name a still-default session after its first message, like Claude Code /
  // ChatGPT do — the broadcast from updateSession refreshes the sidebar.
  const fresh = await getSession(req.params.id);
  if (fresh && fresh.title === 'New session' && fresh.messages.filter((m) => m.role === 'user').length === 1) {
    const title = (text || stored[0]?.name || mentionsStored[0]?.path || imagesStored[0]?.name || '')
      .split('\n')[0].trim().slice(0, 60);
    if (title) await updateSession(req.params.id, { title });
  }

  // Not awaited — the reply streams in over the WebSocket; the POST just
  // confirms the user's own message landed.
  runTurn({
    sessionId: req.params.id,
    attachments: forPrompt,
    mentions: mentionsForPrompt,
    images: forVision,
    commandPrompt,
    overrides,
  }).catch((err) => console.error('[code] runTurn:', err.message));
  res.status(201).json(message);
});

codeRouter.post('/sessions/:id/stop', async (req, res) => {
  res.json({ ok: true, stopped: stopTurn(req.params.id) });
});

// Confirm or reject a write the agent is holding mid-turn (the Confirm/Reject
// buttons on a pending step). Only 'confirm' applies the change; the turn
// then resumes. The step is patched in place for every device via the
// session's message-update broadcast.
codeRouter.post('/sessions/:id/approval/:approvalId', async (req, res) => {
  const decision = req.body?.decision === 'confirm' ? 'confirm' : 'reject';
  const result = decideApproval(req.params.approvalId, decision);
  if (result.error) return res.status(409).json(result);
  logActivity('code', `Code change ${decision === 'confirm' ? 'confirmed' : 'rejected'} by user`, clientIp(req));
  res.json({ ok: true, decision });
});

// Answer an ask_user question the agent is holding mid-turn (the question
// card's option buttons or text box). The turn then resumes with the answer.
codeRouter.post('/sessions/:id/answer/:questionId', async (req, res) => {
  const result = answerQuestion(req.params.questionId, req.body?.answer);
  if (result.error) return res.status(409).json(result);
  logActivity('code', 'Answered a Code agent question', clientIp(req));
  res.json({ ok: true });
});

// Revert a turn's file changes (Code parity roadmap 2c — the "↩ Revert this
// turn" button on an assistant message). Restores every path the turn's write
// tools changed to its pre-turn state. Only the most recent un-reverted
// checkpoint may go — rolling back an older turn would clobber newer work on
// the same files. Commands the turn ran are not undone.
codeRouter.post('/sessions/:id/revert/:messageId', async (req, res) => {
  if (isBusy(req.params.id)) return res.status(409).json({ error: 'wait for the current turn to finish' });
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const msg = (session.messages || []).find((m) => m.id === req.params.messageId);
  if (!msg?.checkpoint) return res.status(404).json({ error: 'that turn has no checkpoint' });
  if (msg.checkpoint.revertedAt) return res.status(409).json({ error: 'this turn is already reverted' });

  const newest = [...(session.messages || [])].reverse().find((m) => m.checkpoint && !m.checkpoint.revertedAt);
  if (newest && newest.id !== msg.id) {
    return res.status(409).json({ error: 'revert the most recent change first' });
  }

  const result = await revertCheckpoint(req.mcConfig, req.params.id, req.params.messageId);
  if (result.error) return res.status(410).json(result);

  await updateMessage(
    req.params.id,
    req.params.messageId,
    {
      checkpoint: {
        ...msg.checkpoint,
        revertedAt: new Date().toISOString(),
        result: {
          restored: result.restored.length,
          removed: result.removed.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
        },
      },
    },
    { persist: true }
  );
  logActivity(
    'code',
    `Reverted a Code turn — ${result.restored.length} restored, ${result.removed.length} removed (session "${session.title}")`,
    clientIp(req)
  );
  res.json({ ok: true, ...result });
});

// Save a plan-mode reply into the memory file (the "Save plan → memory"
// button). Takes the message's text, adds a dated heading, appends it.
codeRouter.post('/sessions/:id/save-plan', async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const msg = (session.messages || []).find((m) => m.id === req.body?.messageId);
  if (!msg || !(msg.text || '').trim()) return res.status(400).json({ error: 'no plan text on that message' });

  const title = session.title && session.title !== 'New session' ? session.title : 'session plan';
  // The model's plan usually opens with its own "# Plan …" heading; the dated
  // heading below replaces it, so drop a leading "Plan" title to avoid a double heading.
  const planText = msg.text.trim().replace(/^#{1,4}\s+plan\b[^\n]*(?:\r?\n)+/i, '');
  const block = `## Plan: ${title} — ${new Date().toISOString().slice(0, 10)}\n\n${planText}`;
  try {
    const { rel, bytes } = await appendToMemoryFile(req.mcConfig, block);
    logActivity('code', `Saved a plan to ${rel}`, clientIp(req));
    res.json({ ok: true, rel, bytes });
  } catch (err) {
    res.status(err instanceof WorkspacePathError ? 400 : 500).json({ error: err.message });
  }
});

// ---------- Workspace (read-only in Phase 1) ----------

codeRouter.get('/workspace', async (req, res) => {
  try {
    res.json(await listDir(req.mcConfig, req.query.path));
  } catch (err) {
    if (err instanceof WorkspacePathError) return res.status(400).json({ error: err.message });
    res.status(404).json({ error: 'directory not found' });
  }
});

codeRouter.get('/workspace/file', async (req, res) => {
  try {
    res.json(await readFile(req.mcConfig, req.query.path));
  } catch (err) {
    if (err instanceof WorkspacePathError) return res.status(400).json({ error: err.message });
    res.status(404).json({ error: 'file not found' });
  }
});

// Flat file list for the composer's `@` mention picker (Code parity roadmap
// 3a). Client-side fuzzy-filtered — this just returns the paths.
codeRouter.get('/workspace/files', async (req, res) => {
  try {
    res.json(await listWorkspaceFiles(req.mcConfig));
  } catch {
    res.json({ files: [], truncated: false });
  }
});

// The `/` command picker (Code parity roadmap 3b): the built-ins plus every
// .mc/commands/*.md in the workspace.
codeRouter.get('/commands', async (req, res) => {
  try {
    res.json({ commands: await listCommands(req.mcConfig) });
  } catch {
    res.json({ commands: [] });
  }
});

// A stored attached-image file (Code parity roadmap 4b) — backs the <img> in
// the transcript. `file` is a plain basename written by codeImages.saveImages;
// imageFilePath rejects anything else. Content-type from the extension, nosniff.
const IMG_EXT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};
codeRouter.get('/sessions/:id/image/:file', async (req, res) => {
  const abs = imageFilePath(req.params.id, req.params.file);
  const type = abs && IMG_EXT_TYPES[path.extname(abs).toLowerCase()];
  if (!abs || !type) return res.status(404).json({ error: 'no such image' });
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return res.status(404).json({ error: 'not a file' });
    res.type(type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  } catch {
    res.status(404).json({ error: 'image not found' });
  }
});

// Raw bytes of a workspace image — backs the <img> for a generated image in
// the transcript. Deliberately images only: same safeResolve guard as the
// rest, nosniff, and a fixed content-type from the extension so this can't
// become a way to serve an arbitrary workspace file inline.
const RAW_IMG_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};
codeRouter.get('/workspace/raw', async (req, res) => {
  let target;
  try {
    target = safeResolve(req.mcConfig, String(req.query.path || ''));
  } catch (err) {
    return res.status(400).json({ error: err instanceof WorkspacePathError ? err.message : 'bad path' });
  }
  const type = RAW_IMG_TYPES[path.extname(target).toLowerCase()];
  if (!type) return res.status(415).json({ error: 'only image files are served here' });
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return res.status(404).json({ error: 'not a file' });
    res.type(type);
    res.set('Cache-Control', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(target);
  } catch {
    res.status(404).json({ error: 'file not found' });
  }
});

// The whole workspace as a .zip — reuses zip.js (same streamed archiver as
// the Files tab's folder download). node_modules and .git are left out: both
// are large and regenerable, and this is "give me my project", not a backup.
const ZIP_SKIP_DIRS = new Set(['node_modules', '.git']);
codeRouter.get('/workspace/download-zip', async (req, res) => {
  const root = resolveWorkspacePath(req.mcConfig);
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'the workspace path is not a folder' });
  } catch {
    return res.status(404).json({ error: "the workspace folder doesn't exist yet — nothing to download" });
  }
  const name = path.basename(root) || 'workspace';
  try {
    const { entries } = await planZip(root, { skipDirs: ZIP_SKIP_DIRS });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.zip"`,
    });
    await streamPlannedZip(res, entries);
    res.end();
    logActivity('code', `Downloaded the Code workspace as a .zip`, clientIp(req));
  } catch (err) {
    if (res.headersSent) res.destroy();
    else if (err instanceof ZipTooLargeError) res.status(413).json({ error: err.message });
    else res.status(500).json({ error: err.message });
  }
});

// The resolved workspace directory — shown in the Code view so it's always
// clear where the agent is pointed, even when the configured path is blank.
// Also the two prompt docs' state (source-of-truth + memory file), so the
// view can mark them in the tree, size their cost into the context meter, and
// offer to create the source-of-truth one when missing.
codeRouter.get('/workspace-info', async (req, res) => {
  const summarise = (doc, rel) =>
    doc ? { name: doc.name, rel, exists: doc.exists, bytes: doc.bytes, truncated: doc.truncated } : null;
  const [cf, mf] = await Promise.all([readContextFile(req.mcConfig), readMemoryFile(req.mcConfig)]);
  res.json({
    path: resolveWorkspacePath(req.mcConfig),
    contextFile: summarise(cf, contextFileRel(req.mcConfig)),
    memoryFile: summarise(mf, memoryFileRel(req.mcConfig)),
  });
});

// Create the source-of-truth file from a starter template — the "you don't
// have one yet" button in the workspace panel. A no-op (200, created:false)
// if it already exists.
codeRouter.post('/workspace/context-file', async (req, res) => {
  try {
    const result = await createContextFile(req.mcConfig);
    if (result.created) logActivity('code', `Code: created ${result.rel} from template`, clientIp(req));
    res.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Static reference data for Settings → Code: the optional-tool set for the
// "tools the agent may use" checklist (Code parity roadmap 2a), and the
// seeded never-run command patterns for the "restore defaults" button (2b).
// The four core reads are always on and aren't in the tool list.
codeRouter.get('/tools', (req, res) => {
  res.json({ tools: OPTIONAL_TOOL_INFO, defaultDenyRules: DEFAULT_DENY });
});

// A model's context window (for the context meter) and its capabilities —
// `vision` tells Settings → Code whether a pick can be the image "eyes" (Code
// parity 4a). Best-effort — nulls/false if Ollama doesn't report or is down.
codeRouter.get('/model-info', async (req, res) => {
  try {
    res.json(await showModel(req.mcConfig.ollama.baseUrl, String(req.query.model || '')));
  } catch {
    res.json({ contextLength: null, capabilities: [], vision: false, tools: false });
  }
});
