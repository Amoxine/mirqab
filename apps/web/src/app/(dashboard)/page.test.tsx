// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react';
import type * as Recharts from 'recharts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import dashboard from '@/messages/en/dashboard.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp } from '@/components/dashboard/test-render';
import DashboardPage from './page';

let granted: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));
vi.mock('@/components/layout/overlays-context', () => ({
  useOverlays: () => ({ openSearch: vi.fn() }),
}));
// Cards with requests and messages of their own that this page test is not about.
vi.mock('@/components/dashboard/sync-summary-card', () => ({ SyncSummaryCard: () => null }));
vi.mock('@/components/dashboard/spec-updates-card', () => ({ SpecUpdatesCard: () => null }));
// jsdom has no layout, so a ResponsiveContainer measures 0 x 0 and draws nothing; give the charts a size.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 280 }),
  };
});

const ORDERS = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const WAIT = { timeout: 8000 };
const P = dashboard.page;
const overview = {
  totalRequests: 90_000, successCount: 89_000, errorCount: 1_000, errorRate: 1.1, avgLatencyMs: 120,
  avgUpstreamLatencyMs: 100, p50LatencyMs: 90, p95LatencyMs: 410, p99LatencyMs: 900, activeApis: 4, activeKeys: 7,
  range: '24h', generatedAt: '2026-09-29T10:00:00.000Z',
};
const health = {
  pipelineReady: true, pumpReachable: true, rawTablePresent: true, aggregateTablePresent: true,
  lastRecordAt: '2026-09-29T10:00:00.000Z', rowCount: 10,
};
const apiRows = [
  { apiDefId: ORDERS, name: 'Orders API', slug: 'orders', status: 'ACTIVE', requests: 1_200, errors: 48, errorRate: 4, avgLatencyMs: 120 },
];
const traffic = {
  range: '24h', windowSeconds: 86_400,
  summary: { requests: 1_000, errors: 0, errorRate: 0, uniqueKeys: 1 },
  timeseries: [], statusClasses: [], statusCodes: [], methods: [], topEndpoints: [], slowestEndpoints: [],
};

/** Every request the page made, by path. */
let paths: () => string[] = () => [];

beforeEach(() => {
  const calls = mockFetch((call) => {
    if (call.path.startsWith('/analytics/health')) return ok(health);
    if (call.path.startsWith('/analytics/overview')) return ok(overview);
    if (call.path.startsWith('/analytics/apis')) return ok(apiRows);
    if (call.path.startsWith('/analytics/traffic')) return ok(traffic);
    if (call.path.startsWith('/apis')) {
      return ok({ data: [{ id: ORDERS, name: 'Orders API', slug: 'orders', status: 'ACTIVE', syncStatus: 'SYNCED' }], meta: { totalCount: 2, totalPages: 1, page: 1, pageSize: 100 } });
    }
    return ok([]);
  });
  paths = () => calls.map((call) => call.path);
});
afterEach(cleanup);

/** One turn of the event loop inside `act`: whatever the page was going to ask for on mount has been asked. */
const settled = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe('the dashboard for someone who may only read analytics', () => {
  beforeEach(() => {
    granted = ['analytics:read'];
  });

  it('asks only for what analytics:read allows: no API list, no gateway nodes, nothing that would be refused', async () => {
    renderApp(<DashboardPage />);
    await screen.findAllByText('Orders API', undefined, WAIT);
    // The KPI strip is the last to mount (it waits for the overview), and it is where the nodes were asked for.
    await screen.findByText(dashboard.kpis.title, undefined, WAIT);
    await settled();
    const made = paths();
    expect(made.length).toBeGreaterThan(0);
    expect(made.filter((path) => !path.startsWith('/analytics/'))).toEqual([]);
  });

  it('offers no "show only this API" button, which would pick a scope it cannot resolve without the API list', async () => {
    renderApp(<DashboardPage />);
    await screen.findAllByText('Orders API', undefined, WAIT);
    expect(screen.queryByRole('button', { name: /Show only/ })).toBeNull();
  });

  it('shows no quick-actions card, which would hold only its own heading', async () => {
    renderApp(<DashboardPage />);
    await screen.findAllByText('Orders API', undefined, WAIT);
    expect(screen.queryByText(P.quickActions)).toBeNull();
  });
});

describe('the dashboard for someone who may read APIs and gateway state', () => {
  beforeEach(() => {
    granted = ['analytics:read', 'api:read', 'settings:read'];
  });

  it('still asks for the API list (the scope) and the gateway nodes, and offers the "show only" button', async () => {
    renderApp(<DashboardPage />);
    await screen.findAllByText('Orders API', undefined, WAIT);
    await waitFor(() => {
      expect(paths()).toContain('/apis?page=1&pageSize=100');
      expect(paths()).toContain('/gateway/nodes/health');
    }, WAIT);
    expect(screen.getAllByRole('button', { name: /Show only/ }).length).toBeGreaterThan(0);
  });

  it('shows the quick-actions card with the shortcuts they may use', async () => {
    renderApp(<DashboardPage />);
    expect(await screen.findByText(P.quickActions, undefined, WAIT)).toBeDefined();
    expect(screen.getByRole('link', { name: P.manageApis })).toBeDefined();
    expect(screen.queryByRole('link', { name: P.manageKeys })).toBeNull();
  });
});
