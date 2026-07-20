import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { versionedAssetsPlugin } from './build/versioned-assets';

export default defineConfig({
  plugins: [versionedAssetsPlugin()],
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
