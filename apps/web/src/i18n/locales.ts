/** Locale constants shared by server (`i18n/request.ts`, `app/locale/route.ts`) and client
 * (`locale-switcher.tsx`) code. No `next/headers` or other server-only import here — that's the
 * whole reason this is a separate file from `request.ts` rather than the same one: `next build`
 * bundles a client component's ENTIRE imported module graph, not just the names it destructures, so
 * a client import of `request.ts` for just `LOCALES` would still drag `next/headers` into the
 * browser bundle and fail the build. */
export const LOCALES = ['en', 'fr', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const RTL_LOCALES: readonly Locale[] = ['ar'];

export function isLocale(value: string | undefined): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? '');
}
