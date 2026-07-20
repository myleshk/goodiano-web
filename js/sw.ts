/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

const AUDIO_CACHE = 'goodiano-audio-v1';

// Navigations must check the network before the precache route can match
// index.html. The precached shell remains the offline fallback.
registerRoute(
  ({ request }) => request.mode === 'navigate',
  async ({ request }) => {
    try {
      return await fetch(new Request(request, { cache: 'reload' }));
    } catch (_) {
      return await matchPrecache('index.html') ?? Response.error();
    }
  },
);

// The audio sprite is intentionally lazy: a storage failure must not prevent
// the small application shell from installing.
registerRoute(
  ({ request, url }) => request.method === 'GET' && url.pathname.endsWith('.m4a'),
  async ({ request }) => {
    const cache = await caches.open(AUDIO_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (!response.ok) return response;
    try {
      const previousSprites = await cache.keys();
      await Promise.all(previousSprites
        .filter(cachedRequest => cachedRequest.url !== request.url)
        .map(cachedRequest => cache.delete(cachedRequest)));
      await cache.put(request, response.clone());
    } catch (_) {
      const clients = await self.clients.matchAll();
      clients.forEach(client => client.postMessage({ type: 'CACHE_ERROR', asset: 'audio' }));
    }
    return response;
  },
);

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(name => name.startsWith('goodiano-') && name !== AUDIO_CACHE)
      .map(name => caches.delete(name)));
  })());
});
clientsClaim();
