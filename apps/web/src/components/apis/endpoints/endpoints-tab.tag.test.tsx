// @vitest-environment jsdom
// Its own file on purpose: in jsdom, a Radix overlay (Sheet, AlertDialog, DropdownMenu) opened by an
// EARLIER test in the same file leaves module-level Radix state behind that stops the next Select
// from committing a choice (bisected; the test passes alone). Vitest gives each file fresh modules,
// so this test does not depend on the order of the others. Not app behaviour: a page load starts clean.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import { baseApi } from '@/components/apis/designer/test-utils';
import type { ApiDetail } from '@/hooks/use-apis';
import { EndpointsTab } from './endpoints-tab';
import { LIST, mockFetch, ok, pendingList, renderUi, REVISION } from './test-utils';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('@/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const api: ApiDetail = { ...baseApi, keyCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EndpointsTab bulk by tag', () => {
  it('with a tag filter, can target every endpoint carrying the tag (sends `tag`, not a page of keys)', async () => {
    const calls = mockFetch((c) => (c.method === 'PATCH' ? ok(pendingList()) : ok(LIST)));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.keyDown(screen.getByRole('combobox', { name: M.filters.tag }), { key: 'ArrowDown' });
    // Keyboard only: tags are sorted, so 'admin' is the option right after 'All tags'.
    const admin = await screen.findByRole('option', { name: 'admin' });
    fireEvent.keyDown(admin, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: M.filters.tag }).textContent).toBe('admin');
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Apply to all 1 endpoint tagged admin/ }));
    fireEvent.keyDown(screen.getByRole('button', { name: M.bulk.actions }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: M.bulk.unblock }));
    await waitFor(() => {
      expect(JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}')).toEqual({
        expectedRevision: REVISION,
        tag: 'admin',
        clear: ['enabled'],
      });
    });
  });
});
