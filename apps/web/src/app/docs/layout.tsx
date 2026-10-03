import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RTL_LOCALES } from '@/i18n/locales';
import { DocsDrawer } from '@/components/docs/docs-drawer';
import { DocsProvider } from '@/components/docs/docs-provider';
import { DocsNavbar, DocsSidebar } from '@/components/docs/docs-sidebar';
import { BrandMark } from '@/components/layout/brand-mark';
import { source } from '@/lib/docs/source';
import { docsI18nUI } from '@/lib/docs/ui-translations';

export default async function Layout({ children }: { children: ReactNode }) {
  // Locale is the app's `locale` cookie (next-intl), not a URL segment.
  const locale = await getLocale();
  const t = await getTranslations('nav');
  const dir = (RTL_LOCALES as readonly string[]).includes(locale) ? 'rtl' : 'ltr';
  const brand = t('brand');
  const title = (
    <>
      <BrandMark className="size-6" />
      {brand}
    </>
  );

  return (
    <DocsProvider dir={dir} i18n={docsI18nUI.provider(locale)}>
      {/* The nav bar and the sidebar are this app's own (see components/docs): Fumadocs' ones hardcode
          English button names and give the mobile menu no dialog behaviour. */}
      <DocsLayout
        tree={source.getPageTree(locale)}
        nav={{ component: <DocsNavbar title={title} url="/" brand={brand} /> }}
        sidebar={{ component: <DocsSidebar title={title} url="/" brand={brand} /> }}
      >
        <DocsDrawer />
        {children}
      </DocsLayout>
    </DocsProvider>
  );
}
