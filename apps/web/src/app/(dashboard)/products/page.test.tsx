// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import apis from '@/messages/en/apis.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import docs from '@/messages/en/docs.json';
import products from '@/messages/en/products.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import ProductsPage from './page';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/products',
  useSearchParams: () => new URLSearchParams(),
}));

const WAIT = { timeout: 8000 };
const LONG = 'OrdersGatewayApiV'.repeat(7).slice(0, 100);
const STAMP = '2026-09-01T10:00:00.000Z';

afterEach(cleanup);

describe('Products list: the APIs a product holds', () => {
  it('shows a long unbroken API name cut with an ellipsis and whole in its tooltip, so it cannot widen a row or a card', async () => {
    mockFetch(() =>
      ok([{ id: 'pr-1', name: 'Partner bundle', slug: 'partner', description: null, apis: [{ id: 'a1', name: LONG }], createdAt: STAMP, updatedAt: STAMP }]),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ products, common, dashboard, docs, apis }}>
          <ProductsPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const name = await screen.findByText(LONG, undefined, WAIT);
    expect(name.className.split(' ')).toContain('truncate');
    const badge = name.parentElement;
    expect(badge?.getAttribute('title')).toBe(LONG);
    // Allowed to shrink to its container: without it the badge is as wide as the name.
    expect(badge?.className.split(' ')).toContain('max-w-full');
  });
});
