// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import arLocaleSwitcher from '@/messages/ar/locale-switcher.json';
import arNav from '@/messages/ar/nav.json';
import enCommon from '@/messages/en/common.json';
import enDashboard from '@/messages/en/dashboard.json';
import enLocaleSwitcher from '@/messages/en/locale-switcher.json';
import enNav from '@/messages/en/nav.json';
import { Header } from './header';

afterEach(cleanup);

vi.mock('next/navigation', () => ({
  usePathname: () => '/analytics/traffic',
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme: () => undefined }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Ada Admin', email: 'ada@example.com', roles: [], permissions: [] } }),
}));
vi.mock('@/hooks/use-permissions', () => ({ usePermissions: () => ({ can: () => false, isLoading: false }) }));
vi.mock('@/components/layout/tenant-switcher', () => ({ TenantSwitcher: () => null }));

const MESSAGES = {
  en: { nav: enNav, common: enCommon, dashboard: enDashboard, localeSwitcher: enLocaleSwitcher },
  ar: { nav: arNav, common: arCommon, dashboard: arDashboard, localeSwitcher: arLocaleSwitcher },
};

function renderHeader(locale: keyof typeof MESSAGES) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <Header />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

// jsdom has no layout, so these pin the classes that keep the header inside a 320px viewport; the
// measured proof (document scrollWidth <= viewport at 320/340/360/375 in en and ar, against the
// compiled CSS) is in the batch report.
describe('Header on a phone', () => {
  it.each(['en', 'ar'] as const)('keeps the docs link off the header below sm, in %s', (locale) => {
    renderHeader(locale);
    const docs = screen.getByRole('link', { name: MESSAGES[locale].dashboard.header.docs });
    expect(docs.getAttribute('href')).toBe('/docs');
    expect(docs.className).toMatch(/(^|\s)max-sm:hidden(\s|$)/);
  });

  it.each(['en', 'ar'] as const)('still reaches the docs from the mobile nav sheet in %s', (locale) => {
    renderHeader(locale);
    // The header's own docs link is the first; the sheet's appears once the menu is open.
    fireEvent.click(screen.getByRole('button', { name: MESSAGES[locale].dashboard.mobileNav.openMenu }));
    const links = screen.getAllByRole('link', { name: MESSAGES[locale].dashboard.header.docs });
    const inSheet = links.find((link) => link.closest('[role="dialog"]') !== null);
    expect(inSheet?.getAttribute('href')).toBe('/docs');
    // Shown only where the header link is not.
    expect(inSheet?.className).toMatch(/(^|\s)sm:hidden(\s|$)/);
  });

  it('closes its controls up on the narrowest phones instead of overflowing', () => {
    renderHeader('en');
    const group = screen.getByRole('link', { name: enDashboard.header.docs }).closest('div.shrink-0');
    expect(group?.className).toMatch(/(^|\s)gap-1\.5(\s|$)/);
    expect(group?.className).toMatch(/(^|\s)sm:gap-2(\s|$)/);
  });
});
