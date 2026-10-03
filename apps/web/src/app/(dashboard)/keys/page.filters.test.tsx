// @vitest-environment jsdom
// Own file: one Radix Select interaction per file (see endpoints-tab.tag.test.tsx for why).
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const page = { data: [], meta: { totalCount: 60, totalPages: 3, page: 1, pageSize: 20 } };

describe('Keys list filters', () => {
  it('resets to page 1 when a filter changes, and never sends the "all" value', async () => {
    const calls = mockFetch(() => ok(page));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={{ keys, common, dashboard, docs, apis, plans }}>
          <KeysPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);
    }, WAIT);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/keys?page=2&pageSize=20')).toBe(true);
    }, WAIT);

    fireEvent.keyDown(screen.getByRole('combobox', { name: keys.list.filters.statusLabel }), {
      key: 'ArrowDown',
    });
    fireEvent.keyDown(await screen.findByRole('option', { name: keys.status.REVOKED }, WAIT), {
      key: 'Enter',
    });
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/keys?page=1&pageSize=20&status=REVOKED')).toBe(true);
    }, WAIT);
    expect(calls.every((c) => !/ALL|__all__/.test(c.path))).toBe(true);
  });
});
