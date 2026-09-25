// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import portalMessages from '@/messages/en/portal.json';
import localeSwitcherMessages from '@/messages/en/locale-switcher.json';
import { PortalHeader } from './portal-header';

afterEach(cleanup);

const M = portalMessages;
let pathname = '/portal';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@/hooks/use-portal', () => ({
  usePortalMe: () => ({ data: { name: 'Dev' } }),
}));
vi.mock('@/lib/kratos-client', () => ({ kratos: {} }));

const renderHeader = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ portal: portalMessages, localeSwitcher: localeSwitcherMessages }}>
      <PortalHeader />
    </NextIntlClientProvider>,
  );

describe('PortalHeader navigation', () => {
  it('always renders both portal links — they are not hidden on phones any more', () => {
    renderHeader();
    const nav = screen.getByRole('navigation', { name: M.nav.ariaLabel });
    // No responsive `hidden` class on the nav: below `sm` it wraps onto its own row instead.
    expect(nav.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole('link', { name: M.nav.catalog })).toBeDefined();
    expect(screen.getByRole('link', { name: M.nav.applications })).toBeDefined();
  });

  it('marks the current section with aria-current, counting product docs as the catalog', () => {
    pathname = '/portal/products/p1';
    renderHeader();
    expect(screen.getByRole('link', { name: M.nav.catalog }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: M.nav.applications }).getAttribute('aria-current')).toBeNull();
  });

  it('marks My Applications on an application page', () => {
    pathname = '/portal/applications/a1';
    renderHeader();
    expect(screen.getByRole('link', { name: M.nav.applications }).getAttribute('aria-current')).toBe('page');
  });

  it('shows no nav on the signed-out auth pages', () => {
    pathname = '/portal/auth/login';
    renderHeader();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
