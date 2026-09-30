import { defineI18n } from 'fumadocs-core/i18n';
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/locales';

// The app's own locale list drives the docs. Fumadocs' i18n middleware is NOT used (the locale comes
// from the `locale` cookie via next-intl). `hideLocale: 'always'` still matters: it makes the loader
// emit `/docs/x` instead of `/fr/docs/x` for page URLs and search-result URLs.
// `fallbackLanguage: 'en'` -> a page missing in fr/ar is served from en (see `page.tsx` banner).
export const docsI18n = defineI18n({
  languages: [...LOCALES],
  defaultLanguage: DEFAULT_LOCALE,
  hideLocale: 'always',
  parser: 'dir',
  fallbackLanguage: 'en',
});
