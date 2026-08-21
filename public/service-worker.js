// Caches the static app shell so the dashboard still loads if the network
// drops out entirely. Deliberately does NOT cache /api/* — this app only
// exists to show live status, so serving stale health data from a service
// worker cache would be actively misleading. The file share (/api/files/*)
// is excluded for the same reason.
//
// Network-first, not stale-while-revalidate: a previous version served
// whatever was already cached *instantly* and only updated the cache in
// the background, which meant a device that cached the shell mid-edit
// could get stuck on a frozen, inconsistent mix of old and new files
// indefinitely — every load kept re-serving that same stale snapshot
// instead of ever picking up the fix. See .claude/DEV_NOTES.md for the
// incident. Now every load tries the network first and only falls back to
// cache when the network request actually fails — cache is purely an
// offline fallback, never a speed shortcut that can outlive its own
// content. Bump CACHE_NAME whenever SHELL_URLS changes so old caches get
// cleaned up. (The WebSocket connection itself is a separate protocol
// upgrade, not a fetch event, so it never passes through this service
// worker at all.)
//
// The network fetch below carries a timeout for the same "never hang
// forever" reason: a stalled request (flaky mobile connection, a server
// that's momentarily slow) previously had no way to trip the .catch()
// fallback, so the page just sat there "loading" indefinitely with
// nothing to click — this bit hardest on the login page after a restart,
// where every device hits this service worker again to re-authenticate at
// once. Now a request that hasn't resolved within FETCH_TIMEOUT_MS aborts
// and falls back to cache like any other failure.
const CACHE_NAME = 'mission-control-shell-v6';
const FETCH_TIMEOUT_MS = 6000;
const SHELL_URLS = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/core.js',
  '/js/dashboard.js',
  '/js/files.js',
  '/js/chat.js',
  '/js/settings.js',
  '/js/omnibox.js',
  '/js/timesheet.js',
  '/js/api.js',
  '/js/connections.js',
  '/js/ws.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
