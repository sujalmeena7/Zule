/**
 * Minimal i18n module for Zule.
 *
 * Resolves user-visible strings through bundled dictionaries for
 * English, Spanish, French, German, Japanese, and Simplified Chinese.
 *
 * Requirements: 17.1, 17.2
 */

import en from './locales/en';
import es from './locales/es';
import fr from './locales/fr';
import de from './locales/de';
import ja from './locales/ja';
import zhHans from './locales/zh-Hans';

export type LocaleCode = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'zh-Hans';

const dictionaries: Record<LocaleCode, Record<string, string>> = {
  en,
  es,
  fr,
  de,
  ja,
  'zh-Hans': zhHans,
};

const SUPPORTED_LOCALES: LocaleCode[] = ['en', 'es', 'fr', 'de', 'ja', 'zh-Hans'];

let activeLocale: LocaleCode = 'en';

/**
 * Set the active locale. If the locale is not supported, defaults to 'en'.
 */
export function setLocale(locale: string): void {
  if (SUPPORTED_LOCALES.includes(locale as LocaleCode)) {
    activeLocale = locale as LocaleCode;
  } else {
    activeLocale = 'en';
  }
}

/**
 * Translate a key using the specified locale (or active locale) dictionary.
 * Falls back to the English dictionary, then returns the key itself.
 */
export function t(key: string, locale?: string): string {
  const resolvedLocale: LocaleCode = locale && SUPPORTED_LOCALES.includes(locale as LocaleCode)
    ? (locale as LocaleCode)
    : activeLocale;
  const dict = dictionaries[resolvedLocale];
  if (dict && dict[key]) {
    return dict[key];
  }
  // Fallback to English
  if (dictionaries.en[key]) {
    return dictionaries.en[key];
  }
  // If not found in any dictionary, return the key
  return key;
}

/**
 * Get the current active locale.
 */
export function getLocale(): LocaleCode {
  return activeLocale;
}

/**
 * Returns the list of supported locales.
 */
export function getSupportedLocales(): LocaleCode[] {
  return [...SUPPORTED_LOCALES];
}

/**
 * Get the dictionary for a specific locale.
 * Useful for property-based testing and validation.
 */
export function getDictionary(locale: LocaleCode): Record<string, string> | undefined {
  return dictionaries[locale];
}
