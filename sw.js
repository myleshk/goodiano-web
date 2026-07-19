/* Goodiano offline shell. All paths are resolved from the installed scope so
 * the app works when hosted below a domain subpath. */
const CACHE_NAME = 'goodiano-v2';
const SHELL = [
  './', './index.html', './css/main.css', './manifest.json',
  './js/app/model.js', './js/app/audio.js', './js/app/keyboard.js',
  './js/app/input.js', './js/app/render.js', './js/app/app.js',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-180.png',
];
const toURL = path => new URL(path, self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A SoundFont is cached only after a successful fetch. This prevents a
    // storage failure from making the entire application shell un-installable.
    await cache.addAll(SHELL.map(toURL));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestURL = new URL(event.request.url);
  const isSoundFont = requestURL.pathname.endsWith('.sf2');
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (!response.ok) return response;
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.put(event.request, response.clone());
      } catch (error) {
        if (isSoundFont) {
          const clients = await self.clients.matchAll();
          clients.forEach(client => client.postMessage({ type: 'CACHE_ERROR', asset: 'SoundFont' }));
        }
      }
      return response;
    } catch (error) {
      if (event.request.mode === 'navigate') return caches.match(toURL('./index.html'));
      throw error;
    }
  })());
});
