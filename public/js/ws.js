// Real-time push layer: connects once, dispatches typed messages to the
// caller's handlers, and reconnects with backoff on drop. This is purely an
// accelerant for the existing REST polling in app.js — if the socket never
// connects (a restrictive proxy, a brief server restart), the app still
// works, it just falls back to catching up on the next poll.
export function connectWebSocket(handlers) {
  let retryDelay = 2000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}`);

    socket.addEventListener('open', () => {
      retryDelay = 2000;
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // ignore malformed frames
      }
      handlers[msg.type]?.(msg);
    });

    socket.addEventListener('close', () => {
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, 30000);
    });

    socket.addEventListener('error', () => socket.close());
  }

  connect();
}
