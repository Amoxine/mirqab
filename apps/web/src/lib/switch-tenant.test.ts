// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { getActiveTenantId, setActiveTenantId } from './active-tenant';
import { queryKeys } from './query-keys';
import { switchTenant } from './switch-tenant';

beforeEach(() => {
  window.localStorage.clear();
});

describe('tenant-scoped query keys', () => {
  it('prefix every dashboard key with the active tenant, read at call time', () => {
    setActiveTenantId('t1');
    expect(queryKeys.apis.list({ page: '1' })).toEqual(['tenant', 't1', 'apis', 'list', { page: '1' }]);
    expect(queryKeys.auth.me).toEqual(['tenant', 't1', 'auth', 'me']);
    setActiveTenantId('t2');
    expect(queryKeys.apis.list({ page: '1' })).toEqual(['tenant', 't2', 'apis', 'list', { page: '1' }]);
  });

  it('keep result-changing filters in the key', () => {
    setActiveTenantId('t1');
    expect(queryKeys.apis.keys('a1', 50)).not.toEqual(queryKeys.apis.keys('a1', 10));
  });
});

describe('switchTenant', () => {
  it('cancels in-flight queries, drops only the previous tenant, then switches and reloads', async () => {
    setActiveTenantId('t1');
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.apis.list({ page: '1' }), { secret: 'tenant-1 data' });
    qc.setQueryData(['tenant', 'other', 'apis'], { kept: true });
    const order: string[] = [];
    const cancel = vi.spyOn(qc, 'cancelQueries').mockImplementation(() => {
      order.push('cancel');
      return Promise.resolve();
    });
    const remove = vi.spyOn(qc, 'removeQueries');
    remove.mockImplementation((filters) => {
      order.push('remove');
      QueryClient.prototype.removeQueries.call(qc, filters);
    });
    const reload = vi.fn(() => order.push('reload'));

    await switchTenant(qc, 't2', reload);

    expect(order).toEqual(['cancel', 'remove', 'reload']);
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['tenant', 't1'] });
    expect(qc.getQueryData(['tenant', 't1', 'apis', 'list', { page: '1' }])).toBeUndefined();
    expect(qc.getQueryData(['tenant', 'other', 'apis'])).toEqual({ kept: true });
    expect(getActiveTenantId()).toBe('t2');
  });

  it('drops the server-default scope when no tenant was chosen yet', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.auth.me, { permissions: ['api:read'] });
    await switchTenant(qc, 't2', () => undefined);
    expect(qc.getQueryData(['tenant', null, 'auth', 'me'])).toBeUndefined();
  });
});
