import { Router } from 'express';
import fs from 'node:fs/promises';
import { loadConfig, saveConfig, resolveSharedFolderPath } from '../config.js';
import { sendTestAlert } from '../alerts.js';
import { normalizeBaseUrl } from '../ollama.js';
import { onConfigChanged as onOllamaConfigChanged } from '../ollamaChat.js';
import { resolveWorkspacePath } from '../codeWorkspace.js';
import { onCodeConfigChanged } from '../codeAgent.js';
import { OPTIONAL_TOOL_INFO } from '../codeTools.js';
import { sanitizeCommandRules } from '../codeCommandRules.js';

const OPTIONAL_NAMES = new Set(OPTIONAL_TOOL_INFO.map((t) => t.name));
import { validateWorkflow, MAPPING_FIELDS } from '../comfyImage.js';
import { isValidCidr, isIpAllowed } from '../ipAllowlist.js';
import { logActivity } from '../activityLog.js';
import { clientIp } from '../net.js';

export const settingsRouter = Router();

const ALERT_FORMATS = new Set(['generic', 'discord', 'slack']);

settingsRouter.put('/', async (req, res) => {
  const config = await loadConfig();
  const body = req.body;
  const ip = clientIp(req);

  if (body.settings) {
    // Whether X-Forwarded-For is trusted (net.js#clientIp). Security-relevant
    // — a wrong setting either lets clients spoof their IP or mislabels every
    // device as the proxy — so a change is logged under 'security', like the
    // IP allowlist and service control below.
    const proxyChanged =
      body.settings.trustProxy !== undefined && !!body.settings.trustProxy !== !!config.settings.trustProxy;
    config.settings = {
      ...config.settings,
      healthCheckIntervalMs: body.settings.healthCheckIntervalMs ?? config.settings.healthCheckIntervalMs,
      healthCheckTimeoutMs: body.settings.healthCheckTimeoutMs ?? config.settings.healthCheckTimeoutMs,
      port: body.settings.port ?? config.settings.port,
      trustProxy:
        body.settings.trustProxy !== undefined ? !!body.settings.trustProxy : config.settings.trustProxy,
    };
    logActivity('settings', 'Updated health-check settings', ip);
    if (proxyChanged) {
      logActivity('security', `Reverse-proxy IP trust ${config.settings.trustProxy ? 'enabled' : 'disabled'}`, ip);
    }
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
    logActivity('settings', 'Updated shared-folder settings', ip);
  }

  if (body.alerts) {
    const webhookUrl = (body.alerts.webhookUrl ?? config.alerts.webhookUrl ?? '').trim();
    const format = body.alerts.format ?? config.alerts.format;
    if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) {
      return res.status(400).json({ error: 'webhook URL must start with http:// or https://' });
    }
    if (!ALERT_FORMATS.has(format)) {
      return res.status(400).json({ error: 'unknown alert format' });
    }
    config.alerts = {
      enabled: body.alerts.enabled !== undefined ? !!body.alerts.enabled : config.alerts.enabled,
      webhookUrl,
      format,
    };
    logActivity('settings', 'Updated external alert settings', ip);
  }

  if (body.ollama) {
    const o = body.ollama;
    const cur = config.ollama;
    const baseUrl = normalizeBaseUrl(o.baseUrl ?? cur.baseUrl ?? '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ error: 'Ollama URL must start with http:// or https://' });
    }
    const trigger = (o.trigger ?? cur.trigger ?? '').trim();
    if (!trigger || /\s/.test(trigger)) {
      return res.status(400).json({ error: 'the trigger must be a single word with no spaces (e.g. @ollama)' });
    }
    // Action tools change something — same rule as service control: no
    // turning them on without password protection to sit behind.
    const wantsActions = o.actions !== undefined ? !!o.actions : cur.actions;
    if (wantsActions && !config.auth?.enabled) {
      return res.status(400).json({ error: 'enable password protection before letting the assistant take actions' });
    }
    const clampInt = (value, lo, hi, fallback) => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    config.ollama = {
      ...cur,
      baseUrl,
      model: typeof o.model === 'string' ? o.model.trim() : cur.model,
      systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt.slice(0, 8000) : cur.systemPrompt,
      botName: typeof o.botName === 'string' && o.botName.trim() ? o.botName.trim().slice(0, 40) : cur.botName,
      botEmoji: typeof o.botEmoji === 'string' ? o.botEmoji.trim().slice(0, 8) || cur.botEmoji : cur.botEmoji,
      trigger,
      contextMessages: clampInt(o.contextMessages, 0, 100, cur.contextMessages),
      keepAlive: typeof o.keepAlive === 'string' && o.keepAlive.trim() ? o.keepAlive.trim().slice(0, 16) : cur.keepAlive,
      numPredict: clampInt(o.numPredict, 0, 8192, cur.numPredict),
      requestTimeoutMs: clampInt(o.requestTimeoutMs, 5000, 600000, cur.requestTimeoutMs),
      tools: o.tools !== undefined ? !!o.tools : cur.tools,
      actions: wantsActions,
      // `active` (the Chat-view toggle) is deliberately NOT settable here —
      // POST /api/ollama/active owns it, so pressing Save in Settings never
      // boots or kills the model as a side effect.
    };
    logActivity('settings', 'Updated Ollama settings', ip);
  }

  if (body.code) {
    const c = body.code;
    const cur = config.code;
    const clamp = (v, lo, hi, fb) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
    };

    // Same rule as service control / assistant actions — the coding agent
    // runs commands on the host, so it can't be turned on without a password
    // gate to sit behind.
    const wantsEnabled = c.enabled !== undefined ? !!c.enabled : cur.enabled;
    if (wantsEnabled && !config.auth?.enabled) {
      return res.status(400).json({ error: 'enable password protection before turning on the Code feature' });
    }

    // A blank path means "auto" (a subfolder of the shared folder, or
    // ./workspace) and is created on first use — only an explicit, changed
    // path is validated up front, same as the shared-folder path check above.
    const workspacePath = typeof c.workspacePath === 'string' ? c.workspacePath.trim() : cur.workspacePath;
    if (workspacePath && workspacePath !== cur.workspacePath) {
      const resolved = resolveWorkspacePath({ ...config, code: { ...cur, workspacePath } });
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) return res.status(400).json({ error: 'workspace path is not a directory' });
      } catch {
        return res.status(400).json({ error: `workspace path does not exist: ${resolved}` });
      }
    }

    // run_command opt-in — like Service Control, it can't go on without the
    // password gate (which config.code.enabled already requires, so this is
    // belt-and-braces).
    const wantsCommands = c.allowCommands !== undefined ? !!c.allowCommands : cur.allowCommands;
    if (wantsCommands && !config.auth?.enabled) {
      return res.status(400).json({ error: 'enable password protection before letting the agent run commands' });
    }

    const wasEnabled = !!cur.enabled;
    const wasCommands = !!cur.allowCommands;
    config.code = {
      ...cur,
      enabled: wantsEnabled,
      workspacePath,
      defaultModel: typeof c.defaultModel === 'string' ? c.defaultModel.trim() : cur.defaultModel,
      // The vision "eyes" model (Code parity 4a) — just a model name; whether
      // it's actually multimodal is surfaced by /api/code/model-info, not
      // enforced here (it may not be pulled yet, or Ollama may be down).
      visionModel: typeof c.visionModel === 'string' ? c.visionModel.trim().slice(0, 80) : cur.visionModel,
      visionTimeoutMs: clamp(c.visionTimeoutMs, 30000, 600000, cur.visionTimeoutMs ?? 240000),
      defaultApprovalMode: ['ask', 'auto-edit', 'auto-all'].includes(c.defaultApprovalMode)
        ? c.defaultApprovalMode
        : cur.defaultApprovalMode,
      maxSteps: clamp(c.maxSteps, 1, 100, cur.maxSteps),
      contextTokens: clamp(c.contextTokens, 2048, 262144, cur.contextTokens),
      // When the running transcript passes this share of the model's window,
      // the turn compacts its earlier steps (Code parity roadmap 1b).
      compactAtPercent: clamp(c.compactAtPercent, 40, 95, cur.compactAtPercent ?? 75),
      // Optional tools the user has switched off (Code parity roadmap 2a) —
      // filtered to real optional tool names so a stale entry can't wedge it.
      disabledTools: Array.isArray(c.disabledTools)
        ? [...new Set(c.disabledTools.filter((n) => OPTIONAL_NAMES.has(n)))]
        : cur.disabledTools || [],
      // The source-of-truth and memory file names (blank = off). Just a
      // name/relative path — path safety is enforced when it's read
      // (codeWorkspace.safeResolve), so this only trims and length-caps.
      contextFileName:
        typeof c.contextFileName === 'string' ? c.contextFileName.trim().slice(0, 120) : cur.contextFileName,
      memoryFileName:
        typeof c.memoryFileName === 'string' ? c.memoryFileName.trim().slice(0, 120) : cur.memoryFileName,
      allowCommands: wantsCommands,
      // Per-command allow/deny globs (Code parity 2b) — trims/dedupes/caps
      // each list; matching + the seeded deny defaults live in codeCommandRules.js.
      commandRules: sanitizeCommandRules(c.commandRules ?? cur.commandRules),
      commandTimeoutMs: clamp(c.commandTimeoutMs, 5000, 600000, cur.commandTimeoutMs),
      // run_checks commands — {label, command} pairs, user-authored. Just
      // trims/caps; they run through codeExec like run_command.
      checks: Array.isArray(c.checks)
        ? c.checks
            .map((x) => ({
              label: typeof x?.label === 'string' ? x.label.trim().slice(0, 40) : '',
              command: typeof x?.command === 'string' ? x.command.trim().slice(0, 500) : '',
            }))
            .filter((x) => x.label && x.command)
            .slice(0, 12)
        : cur.checks,
      checkTimeoutMs: clamp(c.checkTimeoutMs, 5000, 1200000, cur.checkTimeoutMs),
      keepAlive: typeof c.keepAlive === 'string' && c.keepAlive.trim() ? c.keepAlive.trim().slice(0, 16) : cur.keepAlive,
      numPredict: clamp(c.numPredict, 0, 32768, cur.numPredict),
      requestTimeoutMs: clamp(c.requestTimeoutMs, 10000, 1800000, cur.requestTimeoutMs),
    };

    // 'security', not 'settings', for the on/off flips — same reasoning as the
    // IP allowlist / service control below: a change to the app's threat
    // surface, which is what makes it worth a webhook ping too.
    if (wasEnabled !== wantsEnabled) {
      logActivity('security', `Code feature ${wantsEnabled ? 'enabled' : 'disabled'}`, ip);
    } else if (wasCommands !== wantsCommands) {
      logActivity('security', `Code agent shell commands ${wantsCommands ? 'enabled' : 'disabled'}`, ip);
    } else {
      logActivity('settings', 'Updated Code settings', ip);
    }
  }

  if (body.comfy) {
    const cm = body.comfy;
    const cur = config.comfy;
    const clamp = (v, lo, hi, fb) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
    };
    const str = (v, cap, fb) => (typeof v === 'string' ? v.trim().slice(0, cap) : fb);

    // Image generation writes files into the Code workspace and posts into
    // chat, same reach as the Code agent — so it sits behind the password
    // gate too.
    const wantsEnabled = cm.enabled !== undefined ? !!cm.enabled : cur.enabled;
    if (wantsEnabled && !config.auth?.enabled) {
      return res.status(400).json({ error: 'enable password protection before turning on ComfyUI image generation' });
    }

    const baseUrl = normalizeBaseUrl(cm.baseUrl ?? cur.baseUrl ?? '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ error: 'ComfyUI URL must start with http:// or https://' });
    }

    // Reject a broken workflow paste at save time rather than at generation
    // time. Blank is allowed (feature just can't generate until one is set).
    const workflow = typeof cm.workflow === 'string' ? cm.workflow : cur.workflow;
    if (workflow && workflow !== cur.workflow) {
      const check = validateWorkflow(workflow);
      if (!check.ok) return res.status(400).json({ error: `workflow: ${check.error}` });
    }

    // mapping: keep only {field: {node, key}} entries for fields we know.
    let mapping = cur.mapping;
    if (cm.mapping && typeof cm.mapping === 'object' && !Array.isArray(cm.mapping)) {
      mapping = {};
      for (const field of MAPPING_FIELDS) {
        const m = cm.mapping[field];
        if (m && typeof m === 'object' && typeof m.node === 'string') {
          mapping[field] = { node: m.node, key: typeof m.key === 'string' ? m.key : null };
        }
      }
    }

    const wasEnabled = !!cur.enabled;
    config.comfy = {
      ...cur,
      enabled: wantsEnabled,
      baseUrl,
      workflow,
      mapping,
      model: str(cm.model, 200, cur.model),
      defaultNegative: str(cm.defaultNegative, 2000, cur.defaultNegative),
      defaultWidth: clamp(cm.defaultWidth, 64, 4096, cur.defaultWidth),
      defaultHeight: clamp(cm.defaultHeight, 64, 4096, cur.defaultHeight),
      defaultSteps: clamp(cm.defaultSteps, 1, 150, cur.defaultSteps),
      defaultCfg: Number.isFinite(Number(cm.defaultCfg)) ? Math.min(30, Math.max(0, Number(cm.defaultCfg))) : cur.defaultCfg,
      promptPrefix: str(cm.promptPrefix, 500, cur.promptPrefix),
      promptSuffix: str(cm.promptSuffix, 500, cur.promptSuffix),
      timeoutMs: clamp(cm.timeoutMs, 10000, 1800000, cur.timeoutMs),
      ejectAfterMin: clamp(cm.ejectAfterMin, 0, 1440, cur.ejectAfterMin),
      maxPerTurn: clamp(cm.maxPerTurn, 1, 20, cur.maxPerTurn),
      outputDir: str(cm.outputDir, 200, cur.outputDir).replace(/^[/\\]+|[/\\]+$/g, ''),
    };

    if (wasEnabled !== wantsEnabled) {
      logActivity('security', `ComfyUI image generation ${wantsEnabled ? 'enabled' : 'disabled'}`, ip);
    } else {
      logActivity('settings', 'Updated ComfyUI settings', ip);
    }
  }

  if (body.security?.ipAllowlist) {
    const incoming = body.security.ipAllowlist;
    const subnets = Array.isArray(incoming.subnets)
      ? incoming.subnets.map((s) => String(s).trim()).filter(Boolean)
      : config.security.ipAllowlist.subnets;
    const bad = subnets.find((cidr) => !isValidCidr(cidr));
    if (bad) {
      return res.status(400).json({ error: `"${bad}" isn't a valid IP or CIDR range (e.g. 192.168.1.0/24)` });
    }
    const willBeEnabled = incoming.enabled !== undefined ? !!incoming.enabled : config.security.ipAllowlist.enabled;
    if (willBeEnabled && !isIpAllowed({ security: { ipAllowlist: { enabled: true, subnets } } }, ip)) {
      return res.status(400).json({ error: 'this would block your own current IP — add a range that includes it first' });
    }
    config.security = {
      ...config.security,
      ipAllowlist: {
        enabled: incoming.enabled !== undefined ? !!incoming.enabled : config.security.ipAllowlist.enabled,
        subnets,
      },
    };
    // 'security', not 'settings' — this and service control below are the
    // two config changes that actually affect the app's threat surface,
    // which is also what makes them worth a webhook ping (see alerts.js's
    // curated activity relay) unlike a routine settings tweak.
    logActivity(
      'security',
      `Updated IP allowlist (${config.security.ipAllowlist.enabled ? 'on' : 'off'}, ${subnets.length} range${subnets.length === 1 ? '' : 's'})`,
      ip
    );
  }

  if (body.security?.serviceControl) {
    const wantsEnabled = !!body.security.serviceControl.enabled;
    if (wantsEnabled && !config.auth?.enabled) {
      return res.status(400).json({ error: 'enable password protection before turning on service control' });
    }
    config.security = { ...config.security, serviceControl: { enabled: wantsEnabled } };
    logActivity('security', `Service control ${wantsEnabled ? 'enabled' : 'disabled'}`, ip);
  }

  if (body.jellyfin) {
    const j = body.jellyfin;
    const cur = config.jellyfin || { baseUrl: '', apiKey: '' };
    const baseUrl = normalizeBaseUrl(j.baseUrl ?? cur.baseUrl ?? '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ error: 'Jellyfin URL must start with http:// or https://' });
    }
    config.jellyfin = {
      baseUrl,
      // A blank key field means "keep what's saved" — the UI never round-trips
      // the real key (sanitizeConfig strips it), so it can only send a new one.
      apiKey: typeof j.apiKey === 'string' && j.apiKey.trim() ? j.apiKey.trim() : cur.apiKey || '',
    };
    logActivity('settings', 'Updated Jellyfin settings', ip);
  }

  await saveConfig(config);

  // If the Ollama model/URL changed while the assistant is on, re-point the
  // keep-warm loop and preload the new target (no-op if it's off).
  if (body.ollama) onOllamaConfigChanged().catch(() => {});
  // Same for the Code tab's default model.
  if (body.code) onCodeConfigChanged().catch(() => {});

  res.json({
    settings: config.settings,
    sharedFolder: config.sharedFolder,
    alerts: config.alerts,
    ollama: config.ollama,
    code: config.code,
    comfy: config.comfy,
    security: config.security,
    jellyfin: { baseUrl: config.jellyfin?.baseUrl || '', hasApiKey: !!config.jellyfin?.apiKey },
  });
});

// Sends one test message through the currently *saved* webhook config, not
// whatever's unsaved in the form — lets you confirm the URL actually works
// before flipping "Enabled" on for real status changes.
settingsRouter.post('/test-alert', async (req, res) => {
  const config = await loadConfig();
  try {
    await sendTestAlert(config);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
