const SHELL_CACHE = 'code-ai-shell-v3';
const ASSET_CACHE = 'code-ai-assets-v3';
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icons/apple-touch-icon.png',
  '/icons/code-ai-192.png',
  '/icons/code-ai-512.png',
  '/icons/code-ai-maskable-192.png',
  '/icons/code-ai-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return cache.match('/');
      })
    );
    return;
  }

  if (
    request.destination === 'script'
    || request.destination === 'style'
    || url.pathname.startsWith('/assets/')
  ) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        try {
          const response = await fetch(request, { cache: 'no-store' });
          if (response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached = await cache.match(request);
          if (cached) {
            return cached;
          }
          throw new Error(`Failed to fetch asset: ${url.pathname}`);
        }
      })
    );
    return;
  }

  if (
    request.destination === 'image'
    || request.destination === 'font'
  ) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
  }
});
