// Chicago Pacer service worker: cache-first, fully offline after one load.
// Bump VERSION whenever any cached file changes; old caches are deleted on activate.
const VERSION = 'v6';
const CACHE = `chicago-pacer-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './plan.js',
  './course.js',
  './engine.js',
  './sim.js',
  './route.js',
  './manifest.webmanifest',
  './fonts/BigShouldersDisplay-latin.woff2',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Bypass the HTTP cache so a new version never stores stale files.
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('chicago-pacer-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreSearch so ./?sim=60 opens offline too.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = (await cache.match('./index.html')) || (await cache.match('./'));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'version') return;
  const port = event.ports && event.ports[0];
  event.waitUntil((async () => {
    let cached = 0;
    if (await caches.has(CACHE)) cached = (await (await caches.open(CACHE)).keys()).length;
    const reply = { version: VERSION, cache: CACHE, cached };
    if (port) port.postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  })());
});
