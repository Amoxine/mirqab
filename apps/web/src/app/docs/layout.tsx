import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RTL_LOCALES } from '@/i18n/locales';
import { DocsFooterActions } from '@/components/docs/docs-footer-actions';
import { BrandMark } from '@/components/layout/brand-mark';
import { source } from '@/lib/docs/source';
import { docsI18nUI } from '@/lib/docs/ui-translations';

export default async function Layout({ children }: { children: ReactNode }) {
  // Locale is the app's `locale` cookie (next-intl), not a URL segment.
  const locale = await getLocale();
  const t = await getTranslations('nav');
  const dir = (RTL_LOCALES as readonly string[]).includes(locale) ? 'rtl' : 'ltr';

  return (
    <RootProvider
      dir={dir}
      // The app's root <Providers> already mounts next-themes with attribute="class"; reuse it.
      theme={{ enabled: false }}
      search={{ options: { api: '/docs/search-index' } }}
      i18n={docsI18nUI.provider(locale)}
    >
      <DocsLayout
        tree={source.getPageTree(locale)}
        nav={{
          title: (
            <>
              <BrandMark className="size-6" />
              {t('brand')}
            </>
          ),
          url: '/',
        }}
        themeSwitch={{ component: <DocsFooterActions /> }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
