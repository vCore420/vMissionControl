import net from 'node:net';
import dns from 'node:dns';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Curated rather than a full 1-65535 sweep — this only probes ports for the
// kind of self-hosted tools/services this app already targets (see
// CLAUDE-facing README), plus a handful of generic web/admin ports so an
// unrecognized device still shows up as "something's there" instead of
// being invisible.
const PORT_LABELS = {
  22: 'SSH',
  80: 'HTTP',
  443: 'HTTPS',
  445: 'SMB',
  3389: 'RDP',
  3000: 'Web (3000)',
  3001: 'Grafana',
  5000: 'Web (5000)',
  5001: 'Synology DSM',
  7878: 'Radarr',
  8000: 'Web (8000)',
  8006: 'Proxmox',
  8080: 'Web (8080)',
  8096: 'Jellyfin',
  8123: 'Home Assistant',
  8188: 'ComfyUI',
  8443: 'Web (8443)',
  8686: 'Lidarr',
  8989: 'Sonarr',
  9000: 'Portainer',
  9090: 'Prometheus',
  11434: 'Ollama',
  19999: 'Netdata',
  32400: 'Plex',
};

const SCAN_PORTS = Object.keys(PORT_LABELS).map(Number);
const CONNECT_TIMEOUT_MS = 350;
const CONCURRENCY = 80;
const MAX_HOSTS = 1024; // refuses to scan anything bigger than roughly a /22

let scanState = idleState();

function idleState() {
  return { running: false, progress: 0, total: 0, results: [], startedAt: null, finishedAt: null, error: null };
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.');
}

function localSubnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) subnets.push({ address: net.address, netmask: net.netmask });
    }
  }
  return subnets;
}

function hostsInSubnet(address, netmask) {
  const addrInt = ipToInt(address);
  const maskInt = ipToInt(netmask);
  const network = addrInt & maskInt;
  const broadcast = network | (~maskInt >>> 0);
  const hostCount = broadcast - network - 1;
  if (hostCount <= 0 || hostCount > MAX_HOSTS) return null;
  const hosts = [];
  for (let i = network + 1; i < broadcast; i++) hosts.push(intToIp(i));
  return hosts;
}

function probePort(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

async function reverseLookup(ip) {
  try {
    const names = await Promise.race([
      dns.promises.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
    ]);
    return names?.[0]?.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

// A TCP connect to a host on the same L2 segment resolves its MAC via ARP
// as a side effect, so by the time a scan has probed every host, the OS's
// own ARP cache already has most of them — reading it back is free and
// saves the user from having to type a MAC in by hand for Wake-on-LAN.
// Only ever covers same-subnet devices (arp -a doesn't see past a router),
// which happens to be exactly what WOL's broadcast needs anyway.
async function readArpTable() {
  const map = new Map();
  try {
    const { stdout } = await execAsync('arp -a');
    const macRe = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
    for (const line of stdout.split('\n')) {
      const ipMatch = line.match(/(\d{1,3}\.){3}\d{1,3}/);
      const macMatch = line.match(macRe);
      if (ipMatch && macMatch) {
        map.set(ipMatch[0], macMatch[0].replace(/-/g, ':').toLowerCase());
      }
    }
  } catch {
    // arp not on PATH or command failed — discovery still works, just
    // without MAC prefill for the wake-on-LAN field
  }
  return map;
}

async function runWithConcurrency(items, worker, limit) {
  const queue = [...items];
  const runners = new Array(Math.min(limit, items.length) || 1).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export function getScanState() {
  return scanState;
}

export function startScan() {
  if (scanState.running) return scanState;

  let hosts = [];
  for (const { address, netmask } of localSubnets()) {
    const inSubnet = hostsInSubnet(address, netmask);
    if (inSubnet) hosts.push(...inSubnet.filter((h) => h !== address));
  }
  hosts = [...new Set(hosts)];

  if (hosts.length === 0) {
    scanState = {
      ...idleState(),
      startedAt: Date.now(),
      finishedAt: Date.now(),
      error: 'No scannable local subnet found (the network this host is on is either undetectable or too large to scan safely).',
    };
    return scanState;
  }

  scanState = { running: true, progress: 0, total: hosts.length, results: [], startedAt: Date.now(), finishedAt: null, error: null };
  const inThisScan = scanState;

  runWithConcurrency(hosts, async (ip) => {
    const openPorts = [];
    for (const port of SCAN_PORTS) {
      if (await probePort(ip, port)) openPorts.push(port);
    }
    inThisScan.progress += 1;
    if (openPorts.length) {
      const hostname = await reverseLookup(ip);
      inThisScan.results.push({
        ip,
        hostname,
        ports: openPorts.map((port) => ({ port, label: PORT_LABELS[port] || `Port ${port}` })),
      });
      inThisScan.results.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
    }
  }, CONCURRENCY)
    .then(async () => {
      const arpMap = await readArpTable();
      for (const device of inThisScan.results) {
        const mac = arpMap.get(device.ip);
        if (mac) device.mac = mac;
      }
      inThisScan.running = false;
      inThisScan.finishedAt = Date.now();
    })
    .catch((err) => {
      inThisScan.running = false;
      inThisScan.finishedAt = Date.now();
      inThisScan.error = err.message;
    });

  return scanState;
}

// Cooperative only — in-flight probes still finish (bounded by
// CONNECT_TIMEOUT_MS each), they just stop being reported as "running" so
// the client stops polling and a fresh scan can be started.
export function cancelScan() {
  if (scanState.running) {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    scanState.cancelled = true;
  }
  return scanState;
}
