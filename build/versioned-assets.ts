import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** Read one value out of git, or null where git cannot answer. */
function git(...args: string[]): string | null {
  try {
    const value = execFileSync('git', args, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      // git's own diagnostics are not ours to print: a missing repository is a
      // handled case, not a build failure.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : null;
  } catch (_) {
    // No git binary, or no repository — building from a source archive.
    return null;
  }
}

/**
 * Compose the version the app reports. package.json holds the major and minor,
 * which a person chooses and changes rarely; the patch is the commit count, so
 * the version advances by itself on every push and the number in the settings
 * panel always names the running build. Nothing is written back to the
 * repository to make that true.
 *
 * Where git cannot answer — a build from a source archive — the package.json
 * version is used verbatim rather than inventing a number for it.
 */
export function deriveVersion(packageVersion: string, commitCount: string | null): string {
  if (commitCount === null || !/^\d+$/.test(commitCount)) return packageVersion;
  const [major, minor] = packageVersion.split('.');
  if (!major || !minor) return packageVersion;
  return `${major}.${minor}.${commitCount}`;
}

const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url)).toString('utf8')) as {
  version: string;
}).version;

const appVersion = deriveVersion(packageVersion, git('rev-list', '--count', 'HEAD'));
// The commit count alone is only monotonic along one branch. The short hash
// says exactly which commit shipped, which is what a bug report needs.
const appCommit = git('rev-parse', '--short=7', 'HEAD') ?? '';

export function versionedAssetsPlugin(): Plugin {
  let productionBuild = false;
  const icons = ([180, 192, 512] as const).map(size => {
    const source = publicFile(`assets/icons/icon-${size}.png`);
    return { size, source, fileName: `assets/icon-${size}-${digest(source)}.png` };
  });
  const audioSource = publicFile('assets/yamaha-u1.m4a');
  const audioFileName = `assets/yamaha-u1-${digest(audioSource)}.m4a`;
  const manifestBase = JSON.parse(publicFile('manifest.base.json').toString('utf8')) as {
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };
  const manifests = Object.fromEntries((['en', 'zh-CN', 'zh-TW'] as const).map(locale => {
    const localeOverrides = JSON.parse(publicFile(`manifest.${locale}.json`).toString('utf8')) as {
      lang: string; description: string;
    };
    const manifest = { ...manifestBase, ...localeOverrides };
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
          export const version = ${JSON.stringify(appVersion)};
          export const commit = ${JSON.stringify(appCommit)};
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
        export const version = ${JSON.stringify(appVersion)};
        export const commit = ${JSON.stringify(appCommit)};
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
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!productionBuild) return html;
        return html
          .replace('assets/yamaha-u1.m4a', `./${audioFileName}`)
          .replace('./manifest.en.json', `./${manifests.en.fileName}`)
          .replace('assets/icons/icon-192.png', `./${icons.find(icon => icon.size === 192)!.fileName}`)
          .replace('assets/icons/icon-512.png', `./${icons.find(icon => icon.size === 512)!.fileName}`)
          .replace('assets/icons/icon-180.png', `./${icons.find(icon => icon.size === 180)!.fileName}`);
      },
    },
  };
}
