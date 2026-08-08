/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

const AUDIO_CACHE = 'goodiano-audio-v1';

/** Replace any previously cached sprite with this one. Returns false on failure. */
async function storeAudioResponse(cache: Cache, request: Request, response: Response): Promise<boolean> {
  try {
    const previousSprites = await cache.keys();
    await Promise.all(previousSprites
      .filter(cachedRequest => cachedRequest.url !== request.url)
      .map(cachedRequest => cache.delete(cachedRequest)));
    await cache.put(request, response.clone());
    return true;
  } catch (_) {
    return false;
  }
}

async function broadcast(message: unknown): Promise<void> {
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage(message));
}

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
    if (!await storeAudioResponse(cache, request, response)) {
      await broadcast({ type: 'CACHE_ERROR', asset: 'audio' });
    }
    return response;
  },
);

// Storing the sprite can fail on its own (quota, private mode) while playback
// succeeds. The page keeps a retry affordance for exactly that case; without
// this handler the retry could never reach the cache, because the audio route
// only writes on a cache miss and the page already holds the decoded buffer.
self.addEventListener('message', event => {
  const data = event.data as { type?: string; url?: string } | null;
  if (data?.type !== 'RETRY_AUDIO_CACHE' || typeof data.url !== 'string') return;
  const url = data.url;
  event.waitUntil((async () => {
    try {
      const request = new Request(url, { cache: 'reload' });
      const cache = await caches.open(AUDIO_CACHE);
      const response = await fetch(request);
      if (!response.ok) throw new Error(`audio request failed (${response.status})`);
      const stored = await storeAudioResponse(cache, request, response);
      await broadcast({ type: stored ? 'CACHE_READY' : 'CACHE_ERROR', asset: 'audio' });
    } catch (_) {
      await broadcast({ type: 'CACHE_ERROR', asset: 'audio' });
    }
  })());
});

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
