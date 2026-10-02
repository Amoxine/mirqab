// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arAuth from '@/messages/ar/auth.json';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import arKeys from '@/messages/ar/keys.json';
import enAuth from '@/messages/en/auth.json';
import enCommon from '@/messages/en/common.json';
import enDashboard from '@/messages/en/dashboard.json';
import enKeys from '@/messages/en/keys.json';
import frAuth from '@/messages/fr/auth.json';
import frCommon from '@/messages/fr/common.json';
import frDashboard from '@/messages/fr/dashboard.json';
import frKeys from '@/messages/fr/keys.json';
import type { KeyDetail } from '@/hooks/use-keys';
import KeyDetailPage from './page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MESSAGES = {
  en: { auth: enAuth, common: enCommon, dashboard: enDashboard, keys: enKeys },
  fr: { auth: frAuth, common: frCommon, dashboard: frDashboard, keys: frKeys },
  ar: { auth: arAuth, common: arCommon, dashboard: arDashboard, keys: arKeys },
};

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'key-003' }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/keys/key-003',
}));
vi.mock('@/hooks/use-permissions', () => ({ usePermissions: () => ({ can: () => true, isLoading: false }) }));
let detail: KeyDetail;
vi.mock('@/hooks/use-keys', () => ({
  useKey: () => ({ data: detail, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false }),
}));
// Not under test here, and each brings its own data hooks.
vi.mock('@/components/keys/key-usage-card', () => ({ KeyUsageCard: () => null }));
vi.mock('@/components/keys/key-form-sheet', () => ({ KeyFormSheet: () => null }));
vi.mock('@/components/keys/delete-key-dialog', () => ({ DeleteKeyDialog: () => null }));
vi.mock('@/components/keys/key-created-dialog', () => ({ KeyCreatedDialog: () => null }));
vi.mock('@/components/keys/revoke-key-dialog', () => ({ RevokeKeyDialog: () => null }));
vi.mock('@/components/keys/rotate-key-dialog', () => ({ RotateKeyDialog: () => null }));

const keyWithPeriod = (quotaRenewalRate: number, { rate, per } = { rate: 10, per: 1 }): KeyDetail => ({
  id: 'key-003',
  name: 'Partner key',
  status: 'ACTIVE',
  apiDefId: 'api-1',
  apiDefName: 'Orders',
  planId: null,
  planName: null,
  expiresAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  tyk: { rate, per, quotaMax: 1000, quotaRemaining: 900, quotaRenewalRate, quotaRenewsAt: null },
});

/** Renders the page and returns the next-intl errors it logged (console.error from the provider). */
function renderPage(locale: keyof typeof MESSAGES, quotaRenewalRate: number, rate?: { rate: number; per: number }): string[] {
  detail = keyWithPeriod(quotaRenewalRate, rate);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <KeyDetailPage />
    </NextIntlClientProvider>,
  );
  return logged.mock.calls
    .filter(([first]) => (first as { constructor?: { name?: string } } | undefined)?.constructor?.name === 'IntlError')
    .map(([first]) => String(first));
}

describe('key detail page quota period', () => {
  it.each([
    ['en', 'Every 7200 s', '10 req/s'],
    ['fr', 'Toutes les 7200 s', '10 req/s'],
    ['ar', 'كل 7200 ثانية', '10 طلب/ث'],
  ] as const)(
    'spells a non-standard period and the rate out in %s, with no intl error and no raw key',
    (locale, expected, rate) => {
      const intlErrors = renderPage(locale, 7200);

      expect(screen.getByText(expected)).toBeDefined();
      expect(screen.getByText(rate)).toBeDefined();
      expect(document.body.textContent).not.toContain('everyNSeconds');
      expect(document.body.textContent).not.toMatch(/\.rate\.|perSecond/);
      expect(intlErrors).toEqual([]);
    },
  );

  it.each([
    ['en', '100 req / 60 s'],
    ['fr', '100 req / 60 s'],
    ['ar', '100 طلب / 60 ث'],
  ] as const)('spells a per-N-seconds rate out in %s', (locale, rate) => {
    const intlErrors = renderPage(locale, 3600, { rate: 100, per: 60 });

    expect(screen.getByText(rate)).toBeDefined();
    expect(intlErrors).toEqual([]);
  });

  it('names a standard period and logs no intl error', () => {
    const intlErrors = renderPage('en', 3600);

    expect(screen.getByText(enKeys.form.quotaPeriods.HOURLY)).toBeDefined();
    expect(intlErrors).toEqual([]);
  });
});
