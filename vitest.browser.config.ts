import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { versionedAssetsPlugin } from './build/versioned-assets';
import { devCleanupServiceWorker } from './build/dev-cleanup-sw-plugin';

export default defineConfig({
  plugins: [versionedAssetsPlugin(), devCleanupServiceWorker()],
  test: {
    include: ['tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'webkit' }],
      // The default is 30 s, which a cold GitHub runner exceeds: the first page
      // load there has to start the browser, compile the whole app through Vite
      // and instrument it for coverage. Timing out mid-connect closes the page,
      // and vitest then reports "Browser connection was closed while running
      // tests" for whichever file was next, which reads like a test failure and
      // is not one. Two minutes is generous enough to be a real answer.
      connectTimeout: 120_000,
    },
  },
});
