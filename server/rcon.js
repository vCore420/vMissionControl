// Creative roadmap, Phase 5 — a minimal Source RCON client, for Minecraft
// (and any other server that speaks RCON). The protocol is tiny: little-endian
// 32-bit length / request-id / type, a null-terminated ASCII body, a trailing
// null. Built on node:net, no dependency.
//
// Each call opens a fresh connection, authenticates, runs one command, and
// closes — simple, and a game server on a LAN handles that fine. Long
// responses that span multiple packets (a big `list` on a huge server, a
// `help` dump) aren't fully reassembled: this resolves on the first response
// packet, which covers `list` and every normal admin command. Note that in
// the comment if a future need for multi-packet arrives.

import net from 'node:net';

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

function encode(id, type, body) {
  const bodyBuf = Buffer.from(String(body), 'ascii');
  const buf = Buffer.alloc(bodyBuf.length + 14);
  buf.writeInt32LE(bodyBuf.length + 10, 0); // length = 4 (id) + 4 (type) + body + 2 (nulls)
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // two trailing null bytes already zero from Buffer.alloc
  return buf;
}

// { host, port, password, command, timeoutMs } → the command's response text.
// Rejects with a person-readable message on refused / wrong-password / timeout.
export function rconCommand({ host, port, password, command, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: host || '127.0.0.1', port: Number(port) || 25575 });
    socket.setNoDelay(true);

    let stage = 'auth';
    let acc = Buffer.alloc(0);
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`RCON at ${host}:${port} timed out`)), timeoutMs);

    socket.on('connect', () => socket.write(encode(100, SERVERDATA_AUTH, password || '')));

    socket.on('error', (e) => {
      finish(new Error(
        e.code === 'ECONNREFUSED' ? `nothing is listening for RCON at ${host}:${port} — is RCON enabled?`
        : e.code === 'ENOTFOUND' ? `can't resolve the RCON host "${host}"`
        : e.message
      ));
    });

    socket.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 4 && acc.length >= acc.readInt32LE(0) + 4) {
        const len = acc.readInt32LE(0);
        const id = acc.readInt32LE(4);
        const body = acc.toString('ascii', 12, 4 + len - 2);
        acc = acc.subarray(4 + len);

        if (stage === 'auth') {
          if (id === -1) return finish(new Error('RCON authentication failed — wrong password'));
          stage = 'exec';
          socket.write(encode(101, SERVERDATA_EXECCOMMAND, command));
        } else {
          return finish(null, body.trim());
        }
      }
    });

    socket.on('close', () => finish(new Error('RCON connection closed before a response')));
  });
}
