import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';

// One JSON file per namespace per locale (src/messages/<locale>/<namespace>.json), not one big
// file per locale — each translated feature area (apis/keys/tenants/...) then owns a small,
// disjoint set of files instead of every change touching the same 3 giant JSON files.
import enCommon from '@/messages/en/common.json';
import enNav from '@/messages/en/nav.json';
import enLocaleSwitcher from '@/messages/en/locale-switcher.json';
import enAuth from '@/messages/en/auth.json';
import enApis from '@/messages/en/apis.json';
import enKeys from '@/messages/en/keys.json';
import enTenants from '@/messages/en/tenants.json';
import enAnalytics from '@/messages/en/analytics.json';
import enDashboard from '@/messages/en/dashboard.json';

import frCommon from '@/messages/fr/common.json';
import frNav from '@/messages/fr/nav.json';
import frLocaleSwitcher from '@/messages/fr/locale-switcher.json';
import frAuth from '@/messages/fr/auth.json';
import frApis from '@/messages/fr/apis.json';
import frKeys from '@/messages/fr/keys.json';
import frTenants from '@/messages/fr/tenants.json';
import frAnalytics from '@/messages/fr/analytics.json';
import frDashboard from '@/messages/fr/dashboard.json';

import arCommon from '@/messages/ar/common.json';
import arNav from '@/messages/ar/nav.json';
import arLocaleSwitcher from '@/messages/ar/locale-switcher.json';
import arAuth from '@/messages/ar/auth.json';
import arApis from '@/messages/ar/apis.json';
import arKeys from '@/messages/ar/keys.json';
import arTenants from '@/messages/ar/tenants.json';
import arAnalytics from '@/messages/ar/analytics.json';
import arDashboard from '@/messages/ar/dashboard.json';

const MESSAGES = {
  en: {
    common: enCommon,
    nav: enNav,
    localeSwitcher: enLocaleSwitcher,
    auth: enAuth,
    apis: enApis,
    keys: enKeys,
    tenants: enTenants,
    analytics: enAnalytics,
    dashboard: enDashboard,
  },
  fr: {
    common: frCommon,
    nav: frNav,
    localeSwitcher: frLocaleSwitcher,
    auth: frAuth,
    apis: frApis,
    keys: frKeys,
    tenants: frTenants,
    analytics: frAnalytics,
    dashboard: frDashboard,
  },
  ar: {
    common: arCommon,
    nav: arNav,
    localeSwitcher: arLocaleSwitcher,
    auth: arAuth,
    apis: arApis,
    keys: arKeys,
    tenants: arTenants,
    analytics: arAnalytics,
    dashboard: arDashboard,
  },
};

/**
 * No `[locale]` URL segment: this is an authenticated dashboard, not a marketing site that needs
 * per-locale SEO, and every existing route/link/test in the app already assumes today's paths —
 * prefixing all of them would touch every page for no benefit here. Locale is a user preference
 * read from a cookie instead (see `app/locale/route.ts`, the switcher's write side).
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get('locale')?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  return { locale, messages: MESSAGES[locale] };
});
