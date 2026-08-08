import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { versionedAssetsPlugin } from './build/versioned-assets';
import { devCleanupServiceWorker } from './build/dev-cleanup-sw-plugin';

/**
 * Both suites in one run, so coverage reflects the whole app rather than the
 * slice one runner happens to reach. Most of the UI is only exercised in a
 * real browser, so unit-only numbers would be meaningless as a floor.
 *
 * `npm test` and `npm run test:browser` stay as they are for day-to-day work.
 */
export default defineConfig({
  plugins: [versionedAssetsPlugin(), devCleanupServiceWorker()],
  test: {
    projects: [
      {
        plugins: [versionedAssetsPlugin()],
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [versionedAssetsPlugin(), devCleanupServiceWorker()],
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'webkit' }],
          },
        },
      },
    ],
    coverage: {
      // Istanbul rather than v8: v8 coverage in browser mode is Chromium-only,
      // and the browser suite runs WebKit on purpose, to match iOS Safari.
      provider: 'istanbul',
      include: ['js/**/*.ts'],
      // The worker runs outside the page and is covered by its own behavioural
      // tests; instrumenting it here would report it as entirely unreached.
      exclude: ['js/sw.ts', 'js/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // A floor, not a target: set just under what the suites reach today so
      // it catches deletions and untested additions, not normal drift.
      // Measured 85.24 / 70.01 / 81.67 / 90.04 when this landed.
      thresholds: {
        statements: 84,
        branches: 68,
        functions: 80,
        lines: 88,
      },
    },
  },
});
