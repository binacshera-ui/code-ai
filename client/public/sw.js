const SHELL_CACHE = 'code-ai-shell-v9';
const ASSET_CACHE = 'code-ai-assets-v9';
const SHELL_URLS = [
  '/manifest.webmanifest',
  '/manifest.codex.webmanifest',
  '/favicon.png',
  '/icons/apple-touch-icon.png',
  '/icons/code-ai-192.png',
  '/icons/code-ai-512.png',
  '/icons/code-ai-maskable-192.png',
  '/icons/code-ai-maskable-512.png',
];

const OFFLINE_DOCUMENT = `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="3">
    <meta name="theme-color" content="#fafafa">
    <title>code-ai מתחבר מחדש</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#334155;font-family:system-ui,sans-serif}
      main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{line-height:1.8;color:#64748b}
    </style>
  </head>
  <body><main><h1>החיבור ל־code-ai מתחדש</h1><p>השרת לא היה זמין לרגע. הדף ינסה להיטען מחדש אוטומטית.</p></main></body>
</html>`;

function offlineDocumentResponse() {
  return new Response(OFFLINE_DOCUMENT, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isExpectedAssetResponse(request, response) {
  if (!response.ok) {
    return false;
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    return false;
  }

  if (request.destination === 'script') {
    return contentType.includes('javascript') || contentType.includes('ecmascript');
  }

  if (request.destination === 'style') {
    return contentType.includes('text/css');
  }

  return true;
}

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
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          if (response.status >= 500) {
            return offlineDocumentResponse();
          }
          return response;
        })
        .catch(() => offlineDocumentResponse())
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
          if (isExpectedAssetResponse(request, response)) {
            cache.put(request, response.clone());
            return response;
          }

          if (response.ok) {
            return new Response('Invalid asset response', {
              status: 502,
              headers: {
                'Content-Type': 'text/plain; charset=UTF-8',
                'Cache-Control': 'no-store',
              },
            });
          }

          return response;
        } catch {
          const cached = await cache.match(request);
          if (cached && isExpectedAssetResponse(request, cached)) {
            return cached;
          }
          if (cached) await cache.delete(request);
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
