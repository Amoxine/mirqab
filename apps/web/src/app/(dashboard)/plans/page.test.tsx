// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arAuth from '@/messages/ar/auth.json';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import arPlans from '@/messages/ar/plans.json';
import enAuth from '@/messages/en/auth.json';
import enCommon from '@/messages/en/common.json';
import enDashboard from '@/messages/en/dashboard.json';
import enPlans from '@/messages/en/plans.json';
import frAuth from '@/messages/fr/auth.json';
import frCommon from '@/messages/fr/common.json';
import frDashboard from '@/messages/fr/dashboard.json';
import frPlans from '@/messages/fr/plans.json';
import type { Plan } from '@/hooks/use-plans';
import PlansPage from './page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MESSAGES = {
  en: { auth: enAuth, common: enCommon, dashboard: enDashboard, plans: enPlans },
  fr: { auth: frAuth, common: frCommon, dashboard: frDashboard, plans: frPlans },
  ar: { auth: arAuth, common: arCommon, dashboard: arDashboard, plans: arPlans },
};

vi.mock('@/hooks/use-permissions', () => ({ usePermissions: () => ({ can: () => true, isLoading: false }) }));
const plan = (id: string, rate: number, per: number): Plan => ({
  id,
  name: `Plan ${id}`,
  description: null,
  rate,
  per,
  quotaMax: -1,
  quotaPeriod: 'DAILY',
  active: true,
  keyCount: 0,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
});
vi.mock('@/hooks/use-plans', () => ({
  usePlans: () => ({
    data: [plan('a', 10, 1), plan('b', 100, 60), plan('c', 0, 1)],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/plans/plan-form-sheet', () => ({ PlanFormSheet: () => null }));
vi.mock('@/components/plans/delete-plan-dialog', () => ({ DeletePlanDialog: () => null }));

describe('plans list rate column', () => {
  it.each([
    ['en', '10 req/s', '100 req / 60 s'],
    ['fr', '10 req/s', '100 req / 60 s'],
    ['ar', '10 طلب/ث', '100 طلب / 60 ث'],
  ] as const)('spells each rate out in %s, with no intl error', (locale, perSecond, perMinute) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <PlansPage />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText(perSecond)).toBeDefined();
    expect(screen.getByText(perMinute)).toBeDefined();
    // A plan with no rate limit says "unlimited" in the plan's own words (its quota says it too).
    expect(screen.getAllByText(MESSAGES[locale].plans.list.unlimited).length).toBeGreaterThanOrEqual(1);
    expect(
      logged.mock.calls.filter(([first]) => (first as { constructor?: { name?: string } } | undefined)?.constructor?.name === 'IntlError'),
    ).toEqual([]);
  });
});
