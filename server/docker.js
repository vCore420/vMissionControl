// A minimal Docker Engine API client — just enough for container
// start/stop/restart, a container picker list, and a one-shot log fetch.
// Talks to the Engine API directly over its local socket (a Windows named
// pipe here, since Docker Desktop on Windows is the confirmed real target
// per the Service Control plan) rather than pulling in a client library,
// matching this app's existing preference for built-ins over dependencies
// (see auth.js). Falls back to the Unix socket path on non-Windows in case
// this server ever runs there instead.

import http from 'node:http';

const DOCKER_API_VERSION = 'v1.41';
const PING_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;

// Docker Desktop has renamed its Windows named pipe across versions
// (`docker_engine` historically, `dockerDesktopLinuxEngine` on newer
// WSL2-backed installs) — probing both and caching whichever answers is
// more robust than hardcoding one and being wrong for half of installs.
const WINDOWS_PIPE_CANDIDATES = ['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\dockerDesktopLinuxEngine'];
const UNIX_SOCKET_DEFAULT = '/var/run/docker.sock';

let cachedSocketPath = null;

function pingSocket(socketPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path: `/${DOCKER_API_VERSION}/_ping`, method: 'GET', timeout: PING_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function resolveSocketPath() {
  if (cachedSocketPath) return cachedSocketPath;
  const candidates = process.platform === 'win32' ? WINDOWS_PIPE_CANDIDATES : [UNIX_SOCKET_DEFAULT];
  for (const candidate of candidates) {
    if (await pingSocket(candidate)) {
      cachedSocketPath = candidate;
      return candidate;
    }
  }
  throw new Error('Could not reach the Docker Engine API — is Docker Desktop running?');
}

function dockerRequest(socketPath, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: `/${DOCKER_API_VERSION}${path}`, method, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buffer);
            return;
          }
          let message = buffer.toString('utf-8');
          try {
            message = JSON.parse(message).message || message;
          } catch {
            // not JSON — use the raw body as-is
          }
          reject(new Error(`Docker API ${method} ${path} failed (${res.statusCode}): ${message}`));
        });
      }
    );
    req.on('error', (err) => reject(new Error(`Could not reach Docker Engine API: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Docker Engine API request timed out'));
    });
    req.end();
  });
}

const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart']);

export async function dockerContainerAction(container, action) {
  if (!CONTAINER_ACTIONS.has(action)) throw new Error(`unsupported docker action: ${action}`);
  const socketPath = await resolveSocketPath();
  await dockerRequest(socketPath, 'POST', `/containers/${encodeURIComponent(container)}/${action}`);
}

export async function listDockerContainers() {
  const socketPath = await resolveSocketPath();
  const buffer = await dockerRequest(socketPath, 'GET', '/containers/json?all=1');
  const containers = JSON.parse(buffer.toString('utf-8'));
  return containers.map((c) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names?.[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
  }));
}

// Non-TTY containers (the common case) multiplex stdout/stderr into frames
// with an 8-byte header each: [streamType, 0, 0, 0, size(4 bytes BE)]
// followed by `size` bytes of payload. A TTY container's log stream has no
// such framing — it's just raw text — so a header that doesn't look valid
// is treated as "this wasn't framed at all" and the buffer is returned
// as-is rather than misparsed.
function demuxDockerLogStream(buffer) {
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    if (streamType > 2 || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      return buffer.toString('utf-8');
    }
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    lines.push(buffer.slice(start, end).toString('utf-8'));
    offset = end;
  }
  return lines.join('');
}

export async function getContainerLogs(container, { tail = 200 } = {}) {
  const socketPath = await resolveSocketPath();
  const buffer = await dockerRequest(
    socketPath,
    'GET',
    `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&tail=${encodeURIComponent(tail)}&timestamps=0`
  );
  return demuxDockerLogStream(buffer);
}
