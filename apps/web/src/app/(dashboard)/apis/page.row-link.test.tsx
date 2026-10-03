// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import apis from '@/messages/en/apis.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import docs from '@/messages/en/docs.json';
import openapi from '@/messages/en/openapi.json';
import specSource from '@/messages/en/specSource.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import ApisPage from './page';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/apis',
  useSearchParams: () => new URLSearchParams(),
}));

/** The whole suite runs these under load: give every wait a generous window. */
const WAIT = { timeout: 8000 };

const api = (id: string, name: string, slug: string) => ({
  id,
  name,
  slug,
  status: 'ACTIVE',
  authType: 'API_KEY',
  proxyUrl: 'http://upstream',
  listenPath: `/${slug}`,
  tykApiId: null,
  syncStatus: 'SYNCED',
  syncError: null,
  lastSyncedAt: null,
  config: null,
  oasDocument: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
});
const ROWS = [api('a-1', 'Orders API', 'orders'), api('a-2', 'Billing API', 'billing')];

afterEach(cleanup);

describe('APIs list: rows open their detail', () => {
  it('gives every row one hidden link to its detail page, beside the named link to the same place', async () => {
    mockFetch(() => ok({ data: ROWS, meta: { totalCount: 2, totalPages: 1, page: 1, pageSize: 20 } }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ apis, common, dashboard, docs, openapi, specSource }}>
          <ApisPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const named = await screen.findByRole('link', { name: 'Orders API' }, WAIT);
    const hidden = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(hidden.map((a) => a.getAttribute('href'))).toEqual(['/apis/a-1', '/apis/a-2']);
    for (const a of hidden) {
      expect(a.hidden).toBe(true);
      expect(a.getAttribute('aria-hidden')).toBe('true');
      expect(a.getAttribute('tabindex')).toBe('-1');
    }
    // A keyboard or screen reader meets the named link only, never the hidden one.
    expect(named.hasAttribute('data-row-link')).toBe(false);
    expect(named.getAttribute('href')).toBe('/apis/a-1');
    const first = named.closest('tr');
    if (!first) throw new Error('the name is not in a table row');
    expect(within(first).getAllByRole('link').filter((a) => a.getAttribute('href') === '/apis/a-1')).toHaveLength(1);
    expect(first.className).toContain('cursor-pointer');
  });
});
