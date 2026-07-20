import { afterEach, describe, expect, it } from 'vitest';
import { localizedManifestUrls } from 'virtual:goodiano-assets';
import {
  initializeLocalization,
  setLocalePreference,
  subscribeLocaleChange,
  translateDocument,
} from '../../js/app/i18n';

const originalLanguages = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
const originalLanguage = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');

function setBrowserLanguages(languages: string[]): void {
  Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get: () => languages });
  Object.defineProperty(Navigator.prototype, 'language', { configurable: true, get: () => languages[0] ?? '' });
}

afterEach(() => {
  if (originalLanguages) Object.defineProperty(Navigator.prototype, 'languages', originalLanguages);
  if (originalLanguage) Object.defineProperty(Navigator.prototype, 'language', originalLanguage);
  localStorage.clear();
  setLocalePreference('system');
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('browser localization', () => {
  it('selects the automatic locale and honors a persisted override', () => {
    setBrowserLanguages(['zh-HK', 'en']);
    expect(initializeLocalization({ getItem: () => null })).toBe('zh-TW');
    expect(initializeLocalization({ getItem: () => 'zh-CN' })).toBe('zh-CN');
  });

  it('responds to languagechange only while following the system', () => {
    setBrowserLanguages(['zh-CN']);
    initializeLocalization({ getItem: () => null });
    let observed = '';
    const unsubscribe = subscribeLocaleChange(locale => { observed = locale; });

    setBrowserLanguages(['zh-TW']);
    window.dispatchEvent(new Event('languagechange'));
    expect(observed).toBe('zh-TW');

    setLocalePreference('en');
    observed = '';
    setBrowserLanguages(['zh-CN']);
    window.dispatchEvent(new Event('languagechange'));
    expect(observed).toBe('');
    unsubscribe();
  });

  it('updates document language, accessibility text, metadata, and manifest', () => {
    document.head.innerHTML = `
      <meta name="description" content="">
      <link rel="manifest" href="./manifest.en.json">
    `;
    document.body.innerHTML = `
      <button data-i18n-aria-label="settings.open"></button>
      <span data-i18n="loading.failed"></span>
    `;
    setLocalePreference('zh-CN');
    translateDocument();

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('打开设置');
    expect(document.querySelector('span')?.textContent).toContain('加载失败');
    expect(document.querySelector('meta')?.getAttribute('content')).toContain('虚拟钢琴');
    expect(document.querySelector('link')?.getAttribute('href')).toBe(localizedManifestUrls['zh-CN']);
  });
});
