// Reads this host's own Tailscale connection state via the CLI's --json
// output — a real check of whether the tailnet connection is actually up,
// as opposed to pinging a URL. Tailscale doesn't run an HTTP service worth
// health-checking that way, so a service using this check is deliberately
// decoupled from its own `url` field, which stays free to be whatever
// local dashboard link it already points at. Investigated and confirmed
// working directly against Vi's real Tailscale install before building
// this — see the plan discussed in chat for why start/stop/restart were
// deliberately left out (risks cutting the very connection you'd use to
// reach the "start" button again).

import { execFile } from 'node:child_process';

const CHECK_TIMEOUT_MS = 5000;

export function checkTailscaleStatus() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ online: false, detail: err.killed ? 'tailscale status timed out' : 'tailscale CLI not reachable' });
        return;
      }

      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        resolve({ online: false, detail: 'could not parse tailscale status output' });
        return;
      }

      const online = data.BackendState === 'Running' && data.Self?.Online === true;
      const warnings = Array.isArray(data.Health) ? data.Health : [];
      const parts = [];
      if (!online) parts.push(data.BackendState || 'not connected');
      if (data.CurrentTailnet?.Name) parts.push(`tailnet ${data.CurrentTailnet.Name}`);
      if (warnings.length) parts.push(warnings.join('; '));

      resolve({ online, detail: parts.join(' — ') || null });
    });
  });
}
