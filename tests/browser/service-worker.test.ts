import { afterEach, describe, expect, it } from 'vitest';
import { registerServiceWorker } from '../../js/app/service-worker';

async function waitFor(
  fn: () => Promise<boolean>,
  timeout = 8000,
  interval = 50,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function cleanupState(): Promise<{ registrations: number; caches: string[] }> {
  const registrations = (await navigator.serviceWorker.getRegistrations()).length;
  return { registrations, caches: await caches.keys() };
}

describe('development service worker cleanup', () => {
  afterEach(async () => {
    // Best-effort reset so a failed assertion does not leak into other tests.
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
  });

  it('removes a seeded legacy worker and cache on dev navigation', async () => {
    // Seed a legacy worker (served by the dev plugin at /legacy-sw.js).
    await navigator.serviceWorker.register('/legacy-sw.js');
    await waitFor(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg && reg.active != null;
    });

    // Seed a legacy cache.
    const cache = await caches.open('goodiano-legacy-v1');
    await cache.put(new Request('/legacy-asset'), new Response('x'));
    expect((await cleanupState()).caches).toContain('goodiano-legacy-v1');

    // Run the dev cleanup branch.
    registerServiceWorker();

    await waitFor(async () => {
      const state = await cleanupState();
      return state.registrations === 0 && state.caches.length === 0;
    });

    // The cleanup worker has unregistered itself and removed all legacy caches.
    expect((await navigator.serviceWorker.getRegistrations()).length).toBe(0);
  });

  it('does not register a worker when the dev origin is already clean', async () => {
    const before = await cleanupState();
    expect(before.registrations).toBe(0);
    expect(before.caches).toEqual([]);

    registerServiceWorker();

    // Give the dev branch a moment; it must not register a cleanup worker.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await navigator.serviceWorker.getRegistrations()).length).toBe(0);
  });

  it('replaces a legacy registration with the one-shot cleanup worker', async () => {
    await navigator.serviceWorker.register('/legacy-sw.js');
    await waitFor(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active?.scriptURL.endsWith('/legacy-sw.js') === true;
    });
    await caches.open('unrelated-dev-cache');

    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await waitFor(async () => {
      const state = await cleanupState();
      return state.registrations === 0 && state.caches.length === 0;
    });

    expect(navigator.serviceWorker.controller).toBeNull();
  });

  it('serves source CSS from Vite as text/css (never precached)', async () => {
    const res = await fetch('/css/main.css', {
      headers: { Accept: 'text/css,*/*;q=0.1' },
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('text/css');
    const body = await res.text();
    expect(body).toContain('keyboard-content');
  });
});
