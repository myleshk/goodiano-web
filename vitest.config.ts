import { defineConfig } from 'vitest/config';
import { versionedAssetsPlugin } from './build/versioned-assets';

export default defineConfig({
  plugins: [versionedAssetsPlugin()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
