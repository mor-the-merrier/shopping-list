// Service worker: lets the app open without internet (e.g. inside the supermarket).
// Bump the version when you change files, so phones pick up the new code.
const CACHE = 'kniyot-v22';
const VERSION = '22'; // keep in sync with the ?v= numbers in index.html
const APP_FILES = [
  './',
  'index.html',
  'css/style.css?v=' + VERSION,
  'js/parser.js?v=' + VERSION,
  'js/categories.js?v=' + VERSION,
  'js/store.js?v=' + VERSION,
  'js/pdf.js?v=' + VERSION,
  'js/shufersal.js?v=' + VERSION,
  'js/paper.js?v=' + VERSION,
  'js/names.js?v=' + VERSION,
  'js/ocr.js?v=' + VERSION,
  'js/cloud.js?v=' + VERSION,
  'js/app.js?v=' + VERSION,
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, falling back to the cache when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Same-site files: always ask the server whether there's a newer version
  // (GitHub Pages otherwise lets phones keep old files for 10 minutes).
  const sameSite = new URL(e.request.url).origin === location.origin;
  e.respondWith(
    fetch(e.request, sameSite ? { cache: 'no-cache' } : undefined)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => {
          if (hit) return hit;
          // Offline: opening the app falls back to the saved page; any other file
          // (a script, a font) just fails, rather than getting the page in its place.
          if (e.request.mode === 'navigate') return caches.match('./');
          return Response.error();
        })
      )
  );
});
