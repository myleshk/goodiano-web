import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:goodiano-assets';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

type Locale = 'en' | 'zh-CN' | 'zh-TW';

function digest(source: string | Uint8Array): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 10);
}

function publicFile(path: string): Buffer {
  return readFileSync(new URL(`../public/${path}`, import.meta.url));
}

export function versionedAssetsPlugin(): Plugin {
  let productionBuild = false;
  const icons = ([180, 192, 512] as const).map(size => {
    const source = publicFile(`assets/icons/icon-${size}.png`);
    return { size, source, fileName: `assets/icon-${size}-${digest(source)}.png` };
  });
  const audioSource = publicFile('assets/yamaha-u1.m4a');
  const audioFileName = `assets/yamaha-u1-${digest(audioSource)}.m4a`;
  // Static files served verbatim at the site root (e.g. domain verification
  // tokens). They must keep their exact name and content, so they are emitted
  // unhashed straight into the dist root.
  const rootFiles = ['7732954a1dfbfcce60e02ba7fd801701.txt'].map(fileName => ({
    fileName,
    source: publicFile(fileName),
  }));
  const manifests = Object.fromEntries((['en', 'zh-CN', 'zh-TW'] as const).map(locale => {
    const manifest = JSON.parse(publicFile(`manifest.${locale}.json`).toString('utf8')) as {
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };
    manifest.icons = manifest.icons.map(icon => {
      const size = Number.parseInt(icon.sizes, 10);
      const emittedIcon = icons.find(candidate => candidate.size === size);
      if (!emittedIcon) throw new Error(`Missing emitted icon for ${icon.sizes}`);
      return { ...icon, src: `./${emittedIcon.fileName.split('/').pop()}` };
    });
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    return [locale, { source, fileName: `assets/manifest-${locale}-${digest(source)}.webmanifest` }];
  })) as Record<Locale, { source: string; fileName: string }>;

  return {
    name: 'goodiano-versioned-assets',
    configResolved(config) {
      productionBuild = config.command === 'build';
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      if (this.environment.mode === 'dev') {
        return `
          export const audioSpriteUrl = '/assets/yamaha-u1.m4a';
          export const localizedManifestUrls = {
            en: '/manifest.en.json',
            'zh-CN': '/manifest.zh-CN.json',
            'zh-TW': '/manifest.zh-TW.json',
          };
        `;
      }
      const assetBase = 'new URL(/* @vite-ignore */ ".", import.meta.url)';
      return `
        const assetBase = ${assetBase};
        export const audioSpriteUrl = new URL(${JSON.stringify(audioFileName.split('/').pop())}, assetBase).href;
        export const localizedManifestUrls = ${JSON.stringify(Object.fromEntries(
          Object.entries(manifests).map(([locale, manifest]) => [locale, manifest.fileName.split('/').pop()]),
        ))};
        for (const locale in localizedManifestUrls) {
          localizedManifestUrls[locale] = new URL(localizedManifestUrls[locale], assetBase).href;
        }
      `;
    },
    buildStart() {
      if (!productionBuild) return;
      icons.forEach(icon => this.emitFile({ type: 'asset', fileName: icon.fileName, source: icon.source }));
      this.emitFile({ type: 'asset', fileName: audioFileName, source: audioSource });
      Object.values(manifests).forEach(manifest => {
        this.emitFile({ type: 'asset', fileName: manifest.fileName, source: manifest.source });
      });
      rootFiles.forEach(file => {
        this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!productionBuild) return html;
        return html
          .replace('./manifest.en.json', `./${manifests.en.fileName}`)
          .replace('assets/icons/icon-192.png', `./${icons.find(icon => icon.size === 192)!.fileName}`)
          .replace('assets/icons/icon-512.png', `./${icons.find(icon => icon.size === 512)!.fileName}`)
          .replace('assets/icons/icon-180.png', `./${icons.find(icon => icon.size === 180)!.fileName}`);
      },
    },
  };
}
