import dgram from 'node:dgram';

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

export function isValidMac(mac) {
  return typeof mac === 'string' && MAC_RE.test(mac.trim());
}

// Standard Wake-on-LAN magic packet: 6 bytes of 0xFF followed by the target
// MAC repeated 16 times. Sent as a UDP broadcast (255.255.255.255 reaches
// every host on whatever subnet this server itself is on — a device on a
// different subnet/VLAN needs its router to forward directed broadcasts,
// which is out of scope here) on port 9, the conventional WOL "discard"
// port most NIC firmware listens on.
export function sendMagicPacket(mac, { address = '255.255.255.255', port = 9 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isValidMac(mac)) {
      reject(new Error('invalid MAC address'));
      return;
    }

    const macBytes = mac.trim().split(/[:-]/).map((h) => parseInt(h, 16));
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 6; i < 102; i += 6) {
      Buffer.from(macBytes).copy(packet, i);
    }

    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
