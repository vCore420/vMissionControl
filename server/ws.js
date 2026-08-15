import { WebSocketServer } from 'ws';
import { appEvents } from './events.js';

// Push layer for real-time sync across every device that has the dashboard
// open. There's no auth here, same as the REST API — anyone who can reach
// the HTTP server can reach this too, which matches the app's existing
// trusted-LAN threat model rather than introducing a new one.
let wss = null;

export function attachWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket) => {
    socket.on('error', () => {}); // a malformed frame shouldn't take the process down
  });

  appEvents.on('status', (services) => broadcast({ type: 'status', services }));
  appEvents.on('config', (config) => broadcast({ type: 'config', config }));
  appEvents.on('chat:message', ({ channelId, message }) => broadcast({ type: 'chatMessage', channelId, message }));
  appEvents.on('chat:messageDeleted', ({ channelId, messageId }) =>
    broadcast({ type: 'chatMessageDeleted', channelId, messageId })
  );

  return wss;
}

function broadcast(message) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}
