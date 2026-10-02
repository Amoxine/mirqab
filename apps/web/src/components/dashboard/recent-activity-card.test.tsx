// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import analytics from '@/messages/en/analytics.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { RecentActivityCard } from './recent-activity-card';

function renderCard(scope?: { id: string; name: string } | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{ analytics, common, dashboard }}>
        <RecentActivityCard scope={scope} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}
const page = (data: unknown[]) => ok({ data, meta: { page: 1, pageSize: 10, totalCount: data.length, totalPages: 1 } });
const entry = { id: '1', action: 'UPDATED', resource: 'apis', createdAt: '2026-09-29T10:00:00.000Z', user: { name: 'Ada', email: 'a@x.io' } };
const WAIT = { timeout: 8000 };

describe('RecentActivityCard', () => {
  it('asks for everything when the dashboard is not scoped', async () => {
    const calls = mockFetch(() => page([entry]));
    renderCard();
    await screen.findByText('Ada', { exact: false }, WAIT);
    expect(calls[0]?.path).toBe('/audit-logs?page=1&pageSize=10');
  });

  it('asks only for that API\'s entries when scoped, and names the API in the header', async () => {
    const calls = mockFetch(() => page([entry]));
    renderCard({ id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', name: 'Orders API' });
    await screen.findByText('Ada', { exact: false }, WAIT);
    expect(calls[0]?.path).toBe('/audit-logs?page=1&pageSize=10&apiId=6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f');
    expect(screen.getByText('Orders API')).toBeDefined();
  });

  it('opens an entry in the audit log, with its detail sheet showing, from the whole row', async () => {
    mockFetch(() => page([entry, { ...entry, id: '2', action: 'DELETED' }]));
    const { container } = renderCard();
    const link = await screen.findByRole('link', { name: /Updated.*apis.*Ada/ }, WAIT);
    expect(link.getAttribute('href')).toBe('/audit-logs?open=1');
    expect(screen.getByRole('link', { name: /Deleted.*apis/ }).getAttribute('href')).toBe('/audit-logs?open=2');
    // The link's pseudo-element covers the whole entry, so the entry must be its positioned parent.
    expect(link.className).toContain('after:inset-0');
    expect(link.closest('li')?.className).toContain('relative');
    expect(container.querySelectorAll('a a')).toHaveLength(0);
    // "View all" still goes to the list.
    expect(screen.getByRole('link', { name: dashboard.recentActivity.viewAll }).getAttribute('href')).toBe('/audit-logs');
  });

  it('says so when that API has no recorded activity, instead of the gateway-wide empty text', async () => {
    mockFetch(() => page([]));
    renderCard({ id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', name: 'Orders API' });
    expect(await screen.findByText(dashboard.recentActivity.emptyScoped, undefined, WAIT)).toBeDefined();
    expect(screen.queryByText(dashboard.recentActivity.empty)).toBeNull();
  });
});
