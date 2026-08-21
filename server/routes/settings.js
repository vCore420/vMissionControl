import { Router } from 'express';
import fs from 'node:fs/promises';
import { loadConfig, saveConfig, resolveSharedFolderPath } from '../config.js';
import { sendTestAlert } from '../alerts.js';
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
    config.settings = {
      ...config.settings,
      healthCheckIntervalMs: body.settings.healthCheckIntervalMs ?? config.settings.healthCheckIntervalMs,
      healthCheckTimeoutMs: body.settings.healthCheckTimeoutMs ?? config.settings.healthCheckTimeoutMs,
      port: body.settings.port ?? config.settings.port,
    };
    logActivity('settings', 'Updated health-check settings', ip);
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

  await saveConfig(config);
  res.json({ settings: config.settings, sharedFolder: config.sharedFolder, alerts: config.alerts, security: config.security });
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
