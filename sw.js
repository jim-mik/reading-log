// Offline support. App files: network first (so updates show up right away),
// cached copy when offline. The pinned Claude SDK from the CDN: cache first.

const CACHE = 'reading-log-v6';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/util.js', './js/catalog.js', './js/store.js', './js/settings.js', './js/lookup.js',
  './js/ai.js', './js/media.js', './js/stats.js', './js/chart.js', './js/ui.js', './js/pwa.js', './js/merge.js', './js/sync.js', './js/notes.js', './js/classify.js',
  './js/views/home.js', './js/views/shelf.js', './js/views/report.js', './js/views/setup.js',
  './js/views/editor.js', './js/views/book.js', './js/views/scanner.js', './js/views/notes.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (url.host === 'cdn.jsdelivr.net' && url.pathname.includes('@anthropic-ai')) e.respondWith(cacheFirst(req));
});
