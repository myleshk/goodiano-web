/// <reference lib="webworker" />
// Development-only cleanup worker served at /sw.js by the dev server plugin.
// It removes every Cache Storage entry on this origin, reloads controlled
// pages, and then unregisters itself. It must never be part of a
// production build (the plugin that serves it only runs in dev).

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete every cache on this origin (legacy Goodiano caches included).
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));

    // Remove this worker before navigating existing controlled pages. The next
    // document load is therefore uncontrolled and Vite serves every asset.
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    await Promise.all(clients.map((client) => (
      client.navigate(client.url).catch(() => undefined)
    )));
  })());
});
