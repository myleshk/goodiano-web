/**
 * Goodiano PWA Service Worker
 * Caches all assets for offline playability, especially the 14MB SF2.
 */

const CACHE_NAME = 'goodiano-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/main.css',
  '/manifest.json',
  '/js/app/model.js',
  '/js/app/audio.js',
  '/js/app/keyboard.js',
  '/js/app/input.js',
  '/js/app/render.js',
  '/js/app/app.js',
  '/assets/yahama_U1.sf2',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-180.png',
];

// Install: pre-cache all assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first for SF2, network-first for others
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cache-first for large assets (SF2, icons)
  if (url.pathname.endsWith('.sf2') || url.pathname.includes('/assets/icons/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Network-first for code files (get updates when online, fall back to cache)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
