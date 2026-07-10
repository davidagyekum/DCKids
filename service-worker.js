/* DC Kids Brand — service worker
   Strategy:
   - HTML pages: NETWORK-FIRST (so layout edits show up immediately),
     fall back to cache when offline.
   - JS + CSS: NETWORK-FIRST too. App logic changes (e.g. checkout) must reach
     the browser on a normal refresh; cache-first here strands users on stale
     code until VERSION is bumped, which once broke order submission.
   - API: network-first, runtime-cache fallback.
   - Images + fonts: cache-first.
   - Bumping VERSION wipes old caches on activate.
*/
const VERSION = 'dckids-v125';
const STATIC_CACHE = 'dckids-static-' + VERSION;
const RUNTIME_CACHE = 'dckids-runtime-' + VERSION;

// App shell. HTML pages stay network-first; index.html + admin.html are precached
// only so an offline navigation has a correct same-section fallback (an admin
// navigation must never be answered with the storefront).
const APP_SHELL = [
  '/index.html',
  '/admin.html',
  '/styles.css',
  '/manifest.json',
  '/icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Tell the page to reload once the new SW takes control (one-time)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const accept = req.headers.get('accept') || '';
  const isHtml = req.mode === 'navigate' || accept.includes('text/html') || url.pathname.endsWith('.html');
  const isApi = url.pathname.startsWith('/api/');
  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

  // Live store config must NEVER be served from cache — always go to network so
  // admin changes (banner, discount, WhatsApp) reach shoppers immediately.
  const isLiveConfig = url.pathname === '/api/settings' || url.pathname === '/api/products';
  if (isLiveConfig) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // HTML + JS/CSS + API: network-first, cache fallback.
  if (isHtml || isApi || isCode) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((r) => {
        if (r) return r;
        // Offline navigation fallback: keep admin/login navigations on the admin
        // shell. Falling back to /index.html here was bouncing the admin login
        // page to the storefront whenever the network blipped (e.g. the reload
        // right after a new SW takes control).
        const fallback = url.pathname.startsWith('/admin') ? '/admin.html' : '/index.html';
        return caches.match(fallback);
      }))
    );
    return;
  }

  // Images + fonts: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
