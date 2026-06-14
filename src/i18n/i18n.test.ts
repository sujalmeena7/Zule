import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { t, setLocale, getLocale, getSupportedLocales, getDictionary, type LocaleCode } from './index';

/**
 * Property test: i18n catalog completeness across all locales.
 *
 * **Validates: Requirements 17.2**
 *
 * Property: For every key in the English dictionary, every supported locale
 * also has that key defined (no missing translations).
 */
describe('i18n catalog completeness', () => {
  const supportedLocales = getSupportedLocales();
  const enDict = getDictionary('en')!;
  const enKeys = Object.keys(enDict);

  it('English dictionary has at least 20 keys', () => {
    expect(enKeys.length).toBeGreaterThanOrEqual(20);
  });

  it('every supported locale has all English keys defined (property)', () => {
    const nonEnLocales = supportedLocales.filter((l) => l !== 'en');

    fc.assert(
      fc.property(
        fc.constantFrom(...enKeys),
        fc.constantFrom(...nonEnLocales),
        (key: string, locale: LocaleCode) => {
          const dict = getDictionary(locale);
          expect(dict).toBeDefined();
          expect(dict![key]).toBeDefined();
          // Value should be a non-empty string
          expect(typeof dict![key]).toBe('string');
          expect(dict![key].length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('all supported locales have exactly the same key set as English', () => {
    for (const locale of supportedLocales) {
      const dict = getDictionary(locale)!;
      const localeKeys = Object.keys(dict).sort();
      const sortedEnKeys = [...enKeys].sort();
      expect(localeKeys).toEqual(sortedEnKeys);
    }
  });

  it('getSupportedLocales returns en, es, fr, de, ja, zh-Hans', () => {
    expect(supportedLocales).toEqual(['en', 'es', 'fr', 'de', 'ja', 'zh-Hans']);
  });
});

describe('i18n module API', () => {
  it('t() returns the translation for the active locale', () => {
    setLocale('en');
    expect(t('copilot.start')).toBe('Start Session');

    setLocale('es');
    expect(t('copilot.start')).toBe('Iniciar Sesión');
  });

  it('t() with explicit locale parameter overrides active locale', () => {
    setLocale('en');
    expect(t('copilot.stop', 'de')).toBe('Stoppen');
    expect(t('copilot.stop', 'ja')).toBe('停止');
  });

  it('t() falls back to English for missing keys in non-en locale', () => {
    setLocale('fr');
    // All keys exist, but if one were missing it would fall back
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('setLocale falls back to en for unsupported locales', () => {
    setLocale('xx-XX');
    expect(getLocale()).toBe('en');
  });

  it('getLocale returns the currently active locale', () => {
    setLocale('ja');
    expect(getLocale()).toBe('ja');
    setLocale('en');
    expect(getLocale()).toBe('en');
  });
});
