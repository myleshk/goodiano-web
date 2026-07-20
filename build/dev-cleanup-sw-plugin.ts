import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const cleanupWorker = readFileSync(
  new URL('../js/dev-cleanup-sw.js', import.meta.url),
  'utf8',
);

const legacyWorker = `
self.addEventListener('install', () => self.skipWaiting());
`;

/** Serve migration workers only from Vite's development server. */
export function devCleanupServiceWorker(): Plugin {
  return {
    name: 'goodiano-dev-cleanup-service-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const source = pathname === '/sw.js'
          ? cleanupWorker
          : pathname === '/legacy-sw.js'
            ? legacyWorker
            : undefined;

        if (source === undefined) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Service-Worker-Allowed', '/');
        response.end(source);
      });
    },
  };
}
