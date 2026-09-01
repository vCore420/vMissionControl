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

// A fuller read of `tailscale status --json` for the assistant's
// get_tailscale_status tool — self, the peer list (who's on the tailnet
// and whether they're online right now), tailnet name, and any health
// warnings. Same CLI call, just not boiled down to a single boolean.
export function getTailscaleDetail() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ error: err.killed ? 'tailscale status timed out' : 'tailscale CLI not reachable' });
        return;
      }
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        resolve({ error: 'could not parse tailscale status output' });
        return;
      }

      const node = (p) => ({
        name: (p.DNSName || p.HostName || '').replace(/\.$/, '').split('.')[0] || p.HostName || null,
        os: p.OS || null,
        online: !!p.Online,
        addresses: p.TailscaleIPs || [],
        lastSeen: p.Online ? null : p.LastSeen || null,
        isExitNode: !!p.ExitNode,
      });

      resolve({
        connected: data.BackendState === 'Running' && data.Self?.Online === true,
        backendState: data.BackendState || null,
        tailnet: data.CurrentTailnet?.Name || null,
        self: data.Self ? node(data.Self) : null,
        peers: Object.values(data.Peer || {}).map(node),
        healthWarnings: Array.isArray(data.Health) ? data.Health : [],
      });
    });
  });
}
