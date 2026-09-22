import { ar, enUS, fr } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';
import type { Locale } from '@/i18n/locales';

/** Maps this app's locale to date-fns's locale object, for `formatDistanceToNow`/`format` calls
 * that would otherwise always render month names and "in X hours" phrasing in English regardless
 * of the app's own locale. Pass the result as `{ locale }` in date-fns's options. */
const DATE_FNS_LOCALES: Record<Locale, DateFnsLocale> = { en: enUS, fr, ar };

export function dateFnsLocale(locale: Locale): DateFnsLocale {
  return DATE_FNS_LOCALES[locale];
}
