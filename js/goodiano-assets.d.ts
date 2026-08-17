declare module 'virtual:goodiano-assets' {
  import type { SupportedLocale } from './app/i18n';

  export const version: string;
  /** Short hash of the commit this bundle was built from; empty without git. */
  export const commit: string;
  export const audioSpriteUrl: string;
  export const localizedManifestUrls: Record<SupportedLocale, string>;
}
