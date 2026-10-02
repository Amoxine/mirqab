// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { useTrafficSearchHref } from './use-traffic-search-href';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const KEY_ID = '5f1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c11';
const WAIT = { timeout: 8000 };
let paths: () => string[] = () => [];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  const calls = mockFetch(() => ok([{ apiKeyId: KEY_ID, name: 'qbus-web', status: 'ACTIVE', apiDefName: 'Orders API', requests: 1, errors: 0, errorRate: 0, avgLatencyMs: 1 }]));
  paths = () => calls.map((call) => call.path);
});
afterEach(cleanup);

describe('useTrafficSearchHref', () => {
  it('names a filtered key from the analytics keys when the user can open search', async () => {
    granted = ['analytics:read', 'api:update'];
    const { result } = renderHook(() => useTrafficSearchHref({ range: '24h', keyId: KEY_ID }), { wrapper });
    await waitFor(() => {
      expect(result.current()).toContain('key%3Aqbus-web');
    }, WAIT);
    expect(paths()).toEqual(['/analytics/keys?range=24h']);
  });

  it('asks for no key names, and links nowhere, when search is closed to the user', async () => {
    granted = ['analytics:read'];
    const { result } = renderHook(() => useTrafficSearchHref({ range: '24h', keyId: KEY_ID }), { wrapper });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(paths()).toEqual([]);
    expect(result.current()).toBeUndefined();
  });
});
