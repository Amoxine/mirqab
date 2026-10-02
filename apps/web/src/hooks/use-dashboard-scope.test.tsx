// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { render } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { TopApisCard } from '@/components/dashboard/top-apis-card';
import { EndpointTrafficTable } from '@/components/dashboard/endpoint-traffic-table';
import { useDashboardScope } from './use-dashboard-scope';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(search),
}));

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const WAIT = { timeout: 8000 };
const api = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), status: 'ACTIVE', syncStatus: 'SYNCED' });
const list = (...items: ReturnType<typeof api>[]) => ({
  data: items,
  meta: { totalCount: items.length, totalPages: 1, page: 1, pageSize: 100 },
});

const TRAFFIC = {
  range: '24h',
  windowSeconds: 86400,
  summary: {
    requests: 1000, requestsPerSecond: 0.01, errors: 50, errorRate: 5, clientErrors: 40, serverErrors: 10,
    avgLatencyMs: 80, avgUpstreamLatencyMs: 60, p50LatencyMs: 50, p95LatencyMs: 200, p99LatencyMs: 300,
    uniqueClients: 5, uniqueKeys: 3, anonymousShare: 0, bytesIn: 0, lastRequestAt: null,
  },
  timeseries: [],
  statusClasses: [],
  statusCodes: [],
  methods: [],
  topEndpoints: [
    { method: 'GET', path: '/orders', requests: 700, errors: 7, errorRate: 1, avgLatencyMs: 40, p95LatencyMs: 90 },
    { method: 'POST', path: '/orders', requests: 300, errors: 43, errorRate: 14.3, avgLatencyMs: 200, p95LatencyMs: 400 },
  ],
  slowestEndpoints: [],
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{ analytics, common, dashboard }}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  search = '';
  granted = ['analytics:read', 'api:read'];
});

describe('useDashboardScope', () => {
  it('scopes automatically to the only managed API', async () => {
    mockFetch(() => ok(list(api('a1', 'Orders'))));
    const { result } = renderHook(() => useDashboardScope(), { wrapper });
    await waitFor(() => {
      expect(result.current.api?.id).toBe('a1');
    }, WAIT);
    expect(result.current.auto).toBe(true);
  });

  it('stays gateway-wide with several APIs until one is picked in the URL', async () => {
    mockFetch(() => ok(list(api('a1', 'Orders'), api('a2', 'Billing'))));
    const { result, rerender } = renderHook(() => useDashboardScope(), { wrapper });
    await waitFor(() => {
      expect(result.current.api).toBeNull();
    }, WAIT);
    search = 'api=a2';
    rerender();
    await waitFor(() => {
      expect(result.current.api?.id).toBe('a2');
    }, WAIT);
    expect(result.current.auto).toBe(false);
  });

  it('asks for no API list and has no scope without api:read, even for an ?api= in the URL: the request would only be refused', async () => {
    granted = ['analytics:read'];
    search = 'api=a1';
    const calls = mockFetch(() => ok(list(api('a1', 'Orders'))));
    const { result } = renderHook(() => useDashboardScope(), { wrapper });
    // One turn of the event loop inside `act`: whatever the hook was going to ask for on mount has been asked.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toHaveLength(0);
    expect(result.current.api).toBeNull();
    expect(result.current.auto).toBe(false);
  });

  it('ignores an unknown ?api= and writes the choice to the URL', async () => {
    search = 'api=gone&x=1';
    mockFetch(() => ok(list(api('a1', 'Orders'), api('a2', 'Billing'))));
    const { result } = renderHook(() => useDashboardScope(), { wrapper });
    await waitFor(() => {
      expect(result.current.api).toBeNull();
    }, WAIT);
    act(() => {
      result.current.select('a1');
    });
    expect(replace).toHaveBeenCalledWith('/?api=a1&x=1', { scroll: false });
    act(() => {
      result.current.clear();
    });
    expect(replace).toHaveBeenLastCalledWith('/?x=1', { scroll: false });
  });
});

describe('scoped cards', () => {
  it('Top APIs becomes Top endpoints and reads /analytics/traffic, not /analytics/apis', async () => {
    const calls = mockFetch(() => ok(TRAFFIC));
    render(<TopApisCard range="24h" scope={{ id: 'a1', name: 'Orders' }} />, { wrapper });
    expect(await screen.findByRole('heading', { name: /Top endpoints/ }, WAIT)).toBeDefined();
    expect(await screen.findByText('GET /orders', undefined, WAIT)).toBeDefined();
    expect(screen.getByText('POST /orders')).toBeDefined();
    expect(calls.some((c) => c.path.startsWith('/analytics/apis'))).toBe(false);
    expect(calls.some((c) => c.path.includes('/analytics/traffic') && c.path.includes('apiId=a1'))).toBe(true);
    // The overview total comes from the same traffic request: 1000 requests, so 700 = 70 %.
    expect(await screen.findByText('70%', undefined, WAIT)).toBeDefined();
  });

  it('the endpoint table lists each endpoint with its method, error rate and P95', async () => {
    // The table reads the user's permissions (its failed-request links need search), so /auth/me gets its own shape.
    mockFetch((call) => ok(call.path.startsWith('/auth/me') ? { roles: [], permissions: [] } : TRAFFIC));
    render(<EndpointTrafficTable range="24h" scope={{ id: 'a1', name: 'Orders' }} />, { wrapper });
    expect(await screen.findByText('Traffic by endpoint', undefined, WAIT)).toBeDefined();
    // The method is a badge and, for a screen reader, the start of the path link's name: two of them.
    expect((await screen.findAllByText('POST', undefined, WAIT)).length).toBeGreaterThan(0);
    expect(screen.getByText('14.3%')).toBeDefined();
    expect(screen.getByText(/high error rate/)).toBeDefined();
  });
});
