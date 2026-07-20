declare module 'virtual:goodiano-assets' {
  import type { SupportedLocale } from './app/i18n';

  export const version: string;
  export const audioSpriteUrl: string;
  export const localizedManifestUrls: Record<SupportedLocale, string>;
}
