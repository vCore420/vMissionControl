// Caches the static app shell so the dashboard loads instantly and
// survives a brief network blip. Deliberately does NOT cache /api/* —
// this app only exists to show live status, so serving stale health data
// from a service worker cache would be actively misleading. The file
// share (/api/files/*) is excluded for the same reason.
//
// Bump CACHE_NAME whenever SHELL_URLS changes so old caches get cleaned up.
// (The WebSocket connection itself is a separate protocol upgrade, not a
// fetch event, so it never passes through this service worker at all.)
const CACHE_NAME = 'mission-control-shell-v3';
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

  // Stale-while-revalidate: serve the cached shell immediately for speed,
  // then refresh the cache in the background from the network.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
