// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import apis from '@/messages/en/apis.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import docs from '@/messages/en/docs.json';
import keys from '@/messages/en/keys.json';
import plans from '@/messages/en/plans.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import KeysPage from './page';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/keys',
  useSearchParams: () => new URLSearchParams(),
}));

/** The whole suite runs these under load: give every wait a generous window. */
const WAIT = { timeout: 8000 };

const key = (id: string, name: string) => ({
  id,
  name,
  status: 'ACTIVE',
  apiDefId: null,
  apiDefName: null,
  planId: null,
  planName: null,
  expiresAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
});
const ROWS = [key('k-1', 'qbus-web'), key('k-2', 'mobile-app')];

afterEach(cleanup);

describe('Keys list: rows open their detail', () => {
  it('gives every row one hidden link to its detail page, beside the named link to the same place', async () => {
    mockFetch(() => ok({ data: ROWS, meta: { totalCount: 2, totalPages: 1, page: 1, pageSize: 20 } }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ keys, common, dashboard, docs, apis, plans }}>
          <KeysPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const named = await screen.findByRole('link', { name: 'qbus-web' }, WAIT);
    const hidden = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(hidden.map((a) => a.getAttribute('href'))).toEqual(['/keys/k-1', '/keys/k-2']);
    for (const a of hidden) {
      expect(a.hidden).toBe(true);
      expect(a.getAttribute('aria-hidden')).toBe('true');
      expect(a.getAttribute('tabindex')).toBe('-1');
    }
    // A keyboard or screen reader meets the named link only, never the hidden one.
    expect(named.hasAttribute('data-row-link')).toBe(false);
    expect(named.getAttribute('href')).toBe('/keys/k-1');
    const first = named.closest('tr');
    if (!first) throw new Error('the name is not in a table row');
    expect(within(first).getAllByRole('link').filter((a) => a.getAttribute('href') === '/keys/k-1')).toHaveLength(1);
    expect(first.className).toContain('cursor-pointer');
  });
});
