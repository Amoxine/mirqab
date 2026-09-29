// @vitest-environment jsdom
// Own file: one Radix Select interaction per file (see endpoints-tab.tag.test.tsx for why).
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/apis.json';
import { mockFetch, ok, renderUi } from '@/components/apis/endpoints/test-utils';
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

const page = { data: [], meta: { totalCount: 60, totalPages: 3, page: 1, pageSize: 20 } };

describe('APIs list filters', () => {
  it('resets to page 1 when a filter changes, and never sends the "all" value', async () => {
    const calls = mockFetch(() => ok(page));
    renderUi(<ApisPage />);
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis?page=1&pageSize=20')).toBe(true);
    }, WAIT);

    // "Next" stays disabled until the first response says there is more than one page.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);
    }, WAIT);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis?page=2&pageSize=20')).toBe(true);
    }, WAIT);

    fireEvent.keyDown(screen.getByRole('combobox', { name: M.filters.statusLabel }), {
      key: 'ArrowDown',
    });
    fireEvent.keyDown(await screen.findByRole('option', { name: M.status.active }, WAIT), {
      key: 'Enter',
    });
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis?page=1&pageSize=20&status=ACTIVE')).toBe(true);
    }, WAIT);
    expect(calls.every((c) => !/ALL|__all__/.test(c.path))).toBe(true);
  });
});
