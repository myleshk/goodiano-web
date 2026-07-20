/* Goodiano offline shell. All paths are resolved from the installed scope so
 * the app works when hosted below a domain subpath. */
const CACHE_NAME = 'goodiano-v0.3.0';
const GENERATED_ASSETS = [];
const DEV_SHELL = [
  './', './index.html', './css/main.css', './manifest.en.json', './manifest.zh-CN.json', './manifest.zh-TW.json',
  './js/app/model.ts', './js/app/audio.ts', './js/app/sample-zones.ts', './js/app/keyboard.ts',
  './js/app/input.ts', './js/app/render.ts', './js/app/i18n.ts', './js/app/app.ts',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-180.png',
];
const SHELL = GENERATED_ASSETS.length ? GENERATED_ASSETS : DEV_SHELL;
const toURL = path => new URL(path, self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Audio is cached only after a successful fetch. This prevents a
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
  const isAudio = requestURL.pathname.endsWith('.m4a');

  // Always check the network for navigations so a deployed update is not
  // hidden forever behind the previous cache; retain the cached shell offline.
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(toURL('./index.html'), response.clone());
        }
        return response;
      } catch (_) {
        return caches.match(toURL('./index.html'));
      }
    })());
    return;
  }

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
        if (isAudio) {
          const clients = await self.clients.matchAll();
          clients.forEach(client => client.postMessage({ type: 'CACHE_ERROR', asset: 'audio' }));
        }
      }
      return response;
    } catch (error) {
      if (event.request.mode === 'navigate') return caches.match(toURL('./index.html'));
      throw error;
    }
  })());
});
