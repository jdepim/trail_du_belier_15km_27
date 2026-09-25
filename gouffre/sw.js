// Service worker: versioned cache-first so the game runs offline once loaded.
// Bump VERSION on every release (old caches are deleted on activate).
// Any same-origin GET is cached on first fetch, so new files need no list update;
// CORE is only the set pre-cached at install.
const VERSION = 'gouffre-v4';
const CORE = [
  './', './index.html', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './src/main.js', './src/config.js', './src/rng.js', './src/tiles.js', './src/world.js', './src/worldgen.js',
  './src/physics.js', './src/input.js', './src/player.js', './src/grapple.js', './src/render.js', './src/lighting.js',
  './src/sprites.js', './src/particles.js', './src/audio.js', './src/hud.js', './src/debug.js', './src/ui.js',
  './src/enemies.js', './src/entities.js', './src/meta.js',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
