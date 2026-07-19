import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'goodiano-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const generatedAssets = Object.keys(bundle)
        .filter(fileName => !fileName.endsWith('.map'))
        .map(fileName => `./${fileName}`);
      generatedAssets.push(
        './',
        './index.html',
        './manifest.json',
        './assets/icons/icon-180.png',
        './assets/icons/icon-192.png',
        './assets/icons/icon-512.png',
      );
      const template = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('const GENERATED_ASSETS = [];', `const GENERATED_ASSETS = ${JSON.stringify(generatedAssets)};`),
      });
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [serviceWorkerPlugin()],
  server: {
    allowedHosts: ['.myles.hk'],
  },
  build: {
    target: 'safari15',
    sourcemap: true,
  },
});
