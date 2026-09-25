// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import C from '@/messages/en/common.json';
import { baseApi } from '@/components/apis/designer/test-utils';
import type { ApiDetail } from '@/hooks/use-apis';
import { queryKeys } from '@/lib/query-keys';
import { EndpointsTab } from './endpoints-tab';
import { fail, LIST, mockFetch, never, ok, pendingList, renderUi, REVISION } from './test-utils';

const perms = vi.hoisted(() => ({ granted: new Set<string>(['api:read', 'api:update']) }));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => perms.granted.has(p), isLoading: false }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const api: ApiDetail = { ...baseApi, keyCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  perms.granted = new Set(['api:read', 'api:update']);
});

describe('EndpointsTab', () => {
  it('shows a busy skeleton while the endpoints load', () => {
    mockFetch(() => never());
    const { container } = renderUi(<EndpointsTab api={api} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('explains an API that has no stored spec (404) instead of an error', async () => {
    const calls = mockFetch(() => fail(404, 'No specification'));
    renderUi(<EndpointsTab api={api} />);
    expect(await screen.findByText(M.noSpec.title)).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('with no stored spec, offers api:update users to upload one (the same sheet, version 0)', async () => {
    mockFetch(() => fail(404, 'No specification'));
    renderUi(<EndpointsTab api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: M.noSpec.upload }));
    expect(await screen.findByText(M.specUpdate.firstDescription)).toBeDefined();
  });

  it('with no stored spec, a read-only user gets no upload action', async () => {
    perms.granted = new Set(['api:read']);
    mockFetch(() => fail(404, 'No specification'));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText(M.noSpec.title);
    expect(screen.queryByRole('button', { name: M.noSpec.upload })).toBeNull();
  });

  it('shows a load error with a retry that refetches', async () => {
    const calls = mockFetch(() => fail(500, 'boom'));
    renderUi(<EndpointsTab api={api} />);
    // A 5xx is retried twice by the query (a 404 never is) before the error shows.
    expect(await screen.findByText(M.loadError, undefined, { timeout: 10_000 })).toBeDefined();
    expect(calls.filter((c) => c.path === '/apis/api-1/endpoints')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: C.retry }));
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/apis/api-1/endpoints').length).toBeGreaterThan(3);
    });
  });

  it('lists endpoints with method, LTR path, tags, what is governed, orphans and the three warnings', async () => {
    mockFetch(() => ok(LIST));
    renderUi(<EndpointsTab api={api} />);
    const path = await screen.findByText('/orders');
    expect(path.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('GET')).toBeDefined();
    expect(screen.getByText('10 per 60s')).toBeDefined();
    expect(screen.getByText(M.chips.inherits)).toBeDefined();
    expect(screen.getByText(M.table.deprecated)).toBeDefined();
    expect(screen.getByText('GET /legacy')).toBeDefined();
    // Contract §6: the hard-boundary and HEAD copy is always visible next to the switch.
    expect(screen.getByText(M.restrict.boundary)).toBeDefined();
    expect(screen.getAllByText(M.restrict.methods).length).toBeGreaterThan(0);
  });

  it('filters by search text and offers to clear filters when nothing matches', async () => {
    mockFetch(() => ok(LIST));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.change(screen.getByLabelText(M.filters.search), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText(M.empty.filtered)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: C.clearFilters }));
    expect(screen.getByText('/orders')).toBeDefined();
  });

  it('is read-only without api:update: no selection, no spec update, switch disabled, view instead of edit', async () => {
    perms.granted = new Set(['api:read']);
    mockFetch(() => ok(LIST));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: M.summary.updateSpec })).toBeNull();
    expect(screen.queryByRole('button', { name: M.orphans.remove })).toBeNull();
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'View settings of GET /orders' })).toBeDefined();
  });

  it('bulk-block asks first (count + effect), then sends the selected keys with the current revision', async () => {
    const calls = mockFetch((c) => (c.method === 'PATCH' ? ok(pendingList()) : ok(LIST)));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GET /orders' }));
    const region = screen.getByRole('region', { name: M.bulk.region });
    expect(within(region).getByText('1 endpoint selected')).toBeDefined();
    fireEvent.keyDown(within(region).getByRole('button', { name: M.bulk.actions }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: M.bulk.block }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(M.bulk.confirmBlockTitle)).toBeDefined();
    expect(within(dialog).getByText(/1 endpoint will answer 403/)).toBeDefined();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: M.bulk.block }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')).toBeDefined();
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/apis/api-1/endpoints');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ expectedRevision: REVISION, keys: ['listOrders'], set: { enabled: false } });
    // PENDING is never reported as success (sync-outcome-toast).
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('bulk "allow without a key" asks first and sends nothing when cancelled', async () => {
    const calls = mockFetch(() => ok(LIST));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GET /orders' }));
    fireEvent.keyDown(screen.getByRole('button', { name: M.bulk.actions }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: M.bulk.makePublic }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(M.bulk.confirmPublicTitle)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: C.cancel }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('drops a selected endpoint that disappeared on a refetch', async () => {
    mockFetch(() => ok(LIST));
    const { client } = renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GET /orders' }));
    expect(screen.getByText('1 endpoint selected')).toBeDefined();
    act(() => {
      client.setQueryData(queryKeys.apis.endpoints('api-1'), { ...LIST, endpoints: LIST.endpoints.slice(1) });
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: M.bulk.region })).toBeNull();
    });
  });

  it('card view has its own "select all on this page" control', async () => {
    window.localStorage.setItem('og:apis:endpoints-view', 'card');
    mockFetch(() => ok(LIST));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(await screen.findByRole('checkbox', { name: M.table.selectPage }));
    expect(screen.getByText('2 endpoints selected')).toBeDefined();
    window.localStorage.removeItem('og:apis:endpoints-view');
  });

  it('turning allow-list mode OFF also asks, and uses the revision the dialog opened with', async () => {
    const calls = mockFetch((c) => (c.method === 'PATCH' ? fail(409, 'stale', 'ENDPOINT_REVISION_STALE') : ok({ ...LIST, restrictToSpec: true })));
    const { client } = renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(M.restrict.confirmOffTitle)).toBeDefined();
    act(() => {
      client.setQueryData(queryKeys.apis.endpoints('api-1'), { ...LIST, restrictToSpec: true, revision: 'd'.repeat(64) });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: M.restrict.confirmOff }));
    await waitFor(() => {
      expect(JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}')).toEqual({ expectedRevision: REVISION, restrictToSpec: false });
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.staleRevision);
    });
  });

  it('on a stale revision (409) says why and reloads the list', async () => {
    const calls = mockFetch((c) => (c.method === 'PATCH' ? fail(409, 'stale', 'ENDPOINT_REVISION_STALE') : ok(LIST)));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GET /orders' }));
    fireEvent.keyDown(screen.getByRole('button', { name: M.bulk.actions }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: M.bulk.unblock }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.staleRevision);
    });
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'GET' && c.path === '/apis/api-1/endpoints').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('asks before turning on allow-list mode, then sends restrictToSpec', async () => {
    const calls = mockFetch((c) => (c.method === 'PATCH' ? ok(pendingList({ restrictToSpec: true })) : ok(LIST)));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(M.restrict.confirmTitle)).toBeDefined();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: M.restrict.confirm }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(JSON.parse(patch?.body ?? '{}')).toEqual({ expectedRevision: REVISION, restrictToSpec: true });
    });
  });

  it('removes stale settings only after a confirmation', async () => {
    const calls = mockFetch((c) => (c.method === 'PATCH' ? ok(pendingList({ orphans: [] })) : ok(LIST)));
    renderUi(<EndpointsTab api={api} />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('button', { name: M.orphans.remove }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: M.orphans.remove }));
    await waitFor(() => {
      expect(JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}')).toEqual({
        expectedRevision: REVISION,
        dropOrphans: true,
      });
    });
  });

  it('keeps paths left-to-right in Arabic (RTL)', async () => {
    mockFetch(() => ok(LIST));
    renderUi(<EndpointsTab api={api} />, 'ar');
    const path = await screen.findByText('/orders/{id}');
    expect(path.getAttribute('dir')).toBe('ltr');
    expect(path.closest('[dir="rtl"]')).not.toBeNull();
  });
});
