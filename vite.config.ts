import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { versionedAssetsPlugin } from './build/versioned-assets';
import { devCleanupServiceWorker } from './build/dev-cleanup-sw-plugin';

export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [
    versionedAssetsPlugin(),
    devCleanupServiceWorker(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'js',
      filename: 'sw.ts',
      injectRegister: null,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{html,js,css,png,webmanifest}'],
        sourcemap: false,
      },
    }),
  ],
  server: {
    allowedHosts: ['.myles.hk'],
  },
  build: {
    copyPublicDir: false,
    target: 'safari15',
    // No source map is deployed. "hidden" would keep the weight while making
    // the map undiscoverable, and the sources are already public: this repo
    // builds the deployed bundle byte for byte from the same commit.
    sourcemap: false,
  },
});
