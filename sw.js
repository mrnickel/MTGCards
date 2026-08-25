/* Service worker: precache the app shell; runtime-cache CDN libs and
   Scryfall card images; network-first for the Scryfall API. */
const VERSION = 'v5';
const SHELL_CACHE = 'shell-' + VERSION;
const RUNTIME_CACHE = 'runtime-' + VERSION;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json',
               'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Scryfall API: network-first (fresh data), fall back to cache when offline
  if (url.hostname === 'api.scryfall.com') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) { const copy = r.clone(); caches.open(RUNTIME_CACHE).then(c => c.put(e.request, copy)); }
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // CDN libraries (versioned/immutable) and card images: cache-first
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cards.scryfall.io' || url.hostname === 'tessdata.projectnaptha.com') {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
        // no-cors <script>/<img> loads are "opaque" (status 0) but still cacheable
        if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(RUNTIME_CACHE).then(c => c.put(e.request, copy)); }
        return r;
      }))
    );
    return;
  }

  // Same-origin shell: cache-first, fall back to network
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
  }
});
