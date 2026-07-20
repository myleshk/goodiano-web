export const RELOAD_MARKER = 'goodiano.sw-reloaded';

/** Register production workers, or run the dev cleanup on development origins. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  if (import.meta.env.DEV) {
    void runDevCleanup();
    return;
  }

  if (!import.meta.env.PROD) return;

  let refreshing = false;
  try {
    refreshing = sessionStorage.getItem(RELOAD_MARKER) === '1';
    if (refreshing) sessionStorage.removeItem(RELOAD_MARKER);
  } catch (_) { /* Session storage can be unavailable. */ }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    try { sessionStorage.setItem(RELOAD_MARKER, '1'); } catch (_) { /* Best effort. */ }
    window.location.reload();
  });

  const workerUrl = new URL('sw.js', document.baseURI);
  navigator.serviceWorker.register(workerUrl, { updateViaCache: 'none' })
    .then(registration => registration.update())
    .catch(() => {});
}

/**
 * Development-only secondary safeguard. The /sw.js migration handles pages
 * running an old cached bundle; once the current bundle runs, it can remove any
 * remaining registrations and caches directly.
 */
async function runDevCleanup(): Promise<void> {
  let hadRegistrations = false;
  let hadCaches = false;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    hadRegistrations = registrations.length > 0;
    await Promise.all(registrations.map(registration => registration.unregister()));
  } catch (_) { /* Service worker API can be unavailable. */ }

  try {
    const cacheNames = await caches.keys();
    hadCaches = cacheNames.length > 0;
    await Promise.all(cacheNames.map(name => caches.delete(name)));
  } catch (_) { /* Cache API can be unavailable. */ }

  // An unregistered controller remains attached to this document until its
  // next navigation. Reload once so subsequent asset requests go to Vite.
  if ((hadRegistrations || hadCaches) && navigator.serviceWorker.controller) {
    window.location.reload();
  }
}
