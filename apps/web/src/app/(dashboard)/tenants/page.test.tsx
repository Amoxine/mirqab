// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import apis from '@/messages/en/apis.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import docs from '@/messages/en/docs.json';
import tenants from '@/messages/en/tenants.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import TenantsPage from './page';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/tenants',
  useSearchParams: () => new URLSearchParams(),
}));

/** The whole suite runs these under load: give every wait a generous window. */
const WAIT = { timeout: 8000 };

const tenant = (id: string, name: string, slug: string) => ({
  id,
  name,
  slug,
  status: 'ACTIVE',
  plan: 'PRO',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
});
const ROWS = [tenant('t-1', 'Acme', 'acme'), tenant('t-2', 'Globex', 'globex')];
/** `GET /tenants` is the one list that sends `{ success, data, meta }` and is read as it is. */
const list = { status: 200, body: { success: true, data: ROWS, meta: { totalCount: 2, totalPages: 1, page: 1, pageSize: 20 } } };

afterEach(cleanup);

describe('Tenants list: rows open their detail', () => {
  it('gives every row one hidden link to its detail page, beside the named link to the same place', async () => {
    mockFetch((call) => (call.path.startsWith('/tenants?') ? list : ok({})));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ tenants, common, dashboard, docs, apis }}>
          <TenantsPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const named = await screen.findByRole('link', { name: /Acme/ }, WAIT);
    const hidden = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(hidden.map((a) => a.getAttribute('href'))).toEqual(['/tenants/t-1', '/tenants/t-2']);
    for (const a of hidden) {
      expect(a.hidden).toBe(true);
      expect(a.getAttribute('aria-hidden')).toBe('true');
      expect(a.getAttribute('tabindex')).toBe('-1');
    }
    // A keyboard or screen reader meets the named link only, never the hidden one.
    expect(named.hasAttribute('data-row-link')).toBe(false);
    expect(named.getAttribute('href')).toBe('/tenants/t-1');
    const first = named.closest('tr');
    if (!first) throw new Error('the name is not in a table row');
    expect(within(first).getAllByRole('link').filter((a) => a.getAttribute('href') === '/tenants/t-1')).toHaveLength(1);
    expect(first.className).toContain('cursor-pointer');
  });
});
