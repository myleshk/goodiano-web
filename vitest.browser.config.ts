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
    },
  },
});
