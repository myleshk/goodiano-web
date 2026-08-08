import { describe, expect, it } from 'vitest';
import {
  LOCALE_STORAGE_KEY,
  initializeLocalization,
  resolveLocale,
  setLocalePreference,
  translate,
  translationCatalogs,
} from '../../js/app/i18n';

describe('localization', () => {
  it('matches supported languages and falls back to English', () => {
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('fr-FR')).toBe('en');
    expect(resolveLocale(['fr-FR', 'zh-CN'])).toBe('zh-CN');
  });

  it('handles Chinese scripts and regions', () => {
    expect(resolveLocale('zh-Hant')).toBe('zh-TW');
    expect(resolveLocale('zh-Hant-CN')).toBe('zh-TW');
    expect(resolveLocale('zh-TW')).toBe('zh-TW');
    expect(resolveLocale('zh-HK')).toBe('zh-TW');
    expect(resolveLocale('zh-MO')).toBe('zh-TW');
    expect(resolveLocale('zh-Hans-TW')).toBe('zh-TW');
    expect(resolveLocale('zh-Hans')).toBe('zh-CN');
    expect(resolveLocale('zh-SG')).toBe('zh-CN');
    expect(resolveLocale('zh')).toBe('zh-CN');
  });

  it('persists explicit preferences and removes the system preference', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    setLocalePreference('zh-TW', storage);
    expect(values.get(LOCALE_STORAGE_KEY)).toBe('zh-TW');
    setLocalePreference('system', storage);
    expect(values.has(LOCALE_STORAGE_KEY)).toBe(false);
  });

  it('tolerates invalid stored values and storage failures', () => {
    expect(initializeLocalization({ getItem: () => 'invalid' })).toBe('en');
    expect(() => initializeLocalization({ getItem: () => { throw new Error('blocked'); } })).not.toThrow();
    expect(() => setLocalePreference('zh-CN', {
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    })).not.toThrow();
  });

  it('interpolates parameters without evaluating or dropping unknown placeholders', () => {
    expect(translate('debug.velocity', { note: '<C4>', velocity: 127 }, 'en'))
      .toBe('<C4>  ·  velocity 127');
    expect(translate('debug.velocity', { note: 'C4' }, 'en'))
      .toContain('{velocity}');
  });

  it('provides the complete English key set in every catalog', () => {
    const englishKeys = Object.keys(translationCatalogs.en).toSorted();
    expect(Object.keys(translationCatalogs['zh-CN']).toSorted()).toEqual(englishKeys);
    expect(Object.keys(translationCatalogs['zh-TW']).toSorted()).toEqual(englishKeys);
  });
});
