// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import portalMessages from '@/messages/en/portal.json';
import { wrap } from '@/components/portal/test-utils';
import type { PortalProduct } from '@/hooks/use-portal';
import PortalCatalogPage from './page';

const M = portalMessages;

/** Only the fields `PortalCatalogPage` actually reads off `usePortalProducts()` — not the full
 * react-query `UseQueryResult`, which has far more required fields than this page touches. */
interface MockQueryState {
  data: PortalProduct[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const usePortalProducts = vi.fn<() => MockQueryState>();
vi.mock('@/hooks/use-portal', () => ({
  usePortalProducts: () => usePortalProducts(),
}));

describe('PortalCatalogPage', () => {
  it('shows the empty state when the tenant has no products', () => {
    usePortalProducts.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
    render(wrap(<PortalCatalogPage />));
    expect(screen.getByText(M.catalog.empty)).toBeDefined();
  });

  it('renders one card per product, linking to its docs page', () => {
    usePortalProducts.mockReturnValue({
      data: [
        { id: 'p1', name: 'Orders API', slug: 'orders', description: 'Order management', apis: [{ id: 'a1', name: 'Orders', slug: 'orders' }], createdAt: '', updatedAt: '' },
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    render(wrap(<PortalCatalogPage />));
    const link = screen.getByRole('link', { name: /Orders API/ });
    expect(link.getAttribute('href')).toBe('/portal/products/p1');
  });

  it('shows the error state with a retry action', () => {
    usePortalProducts.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('network down'),
      refetch: vi.fn(),
    });
    render(wrap(<PortalCatalogPage />));
    expect(screen.getByText('network down')).toBeDefined();
  });
});
