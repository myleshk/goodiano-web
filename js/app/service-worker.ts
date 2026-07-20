const RELOAD_MARKER = 'goodiano.sw-reloaded';

/** Register only production workers; development must never cache source URLs. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

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
