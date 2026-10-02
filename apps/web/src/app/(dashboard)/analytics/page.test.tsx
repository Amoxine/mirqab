// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react';
import type * as Recharts from 'recharts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp, withRowClock } from '@/components/dashboard/test-render';
import AnalyticsPage from './page';

const push = vi.fn();
let granted: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));
// jsdom has no layout, so a ResponsiveContainer measures 0 x 0 and draws nothing; give the chart a size.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 280 }),
  };
});

const ORDERS = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const KEY_ID = '5f1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c11';
const overview = {
  totalRequests: 90_000,
  successCount: 89_000,
  errorCount: 1_000,
  errorRate: 1.1,
  avgLatencyMs: 120,
  avgUpstreamLatencyMs: 100,
  p50LatencyMs: 90,
  p95LatencyMs: 410,
  p99LatencyMs: 900,
  activeApis: 4,
  activeKeys: 7,
  range: '24h',
  generatedAt: '2026-09-29T10:00:00.000Z',
};
const health = {
  pipelineReady: true,
  pumpReachable: true,
  rawTablePresent: true,
  aggregateTablePresent: true,
  lastRecordAt: '2026-09-29T10:00:00.000Z',
  rowCount: 10,
};
const apiRows = [
  { apiDefId: ORDERS, name: 'Orders API', slug: 'orders', status: 'ACTIVE', requests: 1_200, errors: 48, errorRate: 4, avgLatencyMs: 120 },
  { apiDefId: 'b', name: 'Quiet API', slug: 'quiet', status: 'ACTIVE', requests: 30, errors: 0, errorRate: 0, avgLatencyMs: 80 },
];
const keyRows = [
  { apiKeyId: KEY_ID, name: 'qbus-web', status: 'ACTIVE', apiDefName: 'Orders API', requests: 700, errors: 14, errorRate: 2, avgLatencyMs: 90 },
];
const statusCodes = [
  { code: '2xx', count: 89_000 },
  { code: '401', count: 400 },
  { code: '4xx', count: 100 },
  { code: '503', count: 300 },
  { code: '5xx', count: 200 },
];
const WAIT = { timeout: 8000 };
const A = analytics;
const target = (el: HTMLElement) => new URL(el.getAttribute('href') ?? '', 'http://x');
/** The pointer-only link laid over a row. */
const rowLink = (row: HTMLElement): HTMLElement => {
  const link = row.querySelector<HTMLElement>('a[data-row-link]');
  if (!link) throw new Error('row has no row link');
  return link;
};
/** The table row whose name is a link; "Orders API" is also plain text in the key table's API column. */
const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;

beforeEach(() => {
  push.mockClear();
  granted = ['analytics:read', 'api:update', 'api:read', 'key:read'];
  mockFetch((call) => {
    if (call.path.startsWith('/analytics/health')) return ok(health);
    if (call.path.startsWith('/analytics/overview')) return ok(overview);
    if (call.path.startsWith('/analytics/apis')) return ok(apiRows);
    if (call.path.startsWith('/analytics/keys')) return ok(keyRows);
    if (call.path.startsWith('/analytics/status-codes')) return ok(statusCodes);
    return ok([]);
  });
});

describe('analytics page click-through: the figures', () => {
  it('opens the traffic view from the request and latency figures', async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByRole('link', { name: A.overview.totalRequests }, WAIT);
    expect(target(screen.getByRole('link', { name: A.overview.totalRequests })).pathname).toBe('/analytics/traffic');
    expect(target(screen.getByRole('link', { name: A.table.columns.avgLatency })).pathname).toBe('/analytics/traffic');
  });

  it('opens the failed requests (status 400 and up, how errors are counted) from both error figures', async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByRole('link', { name: A.table.columns.errors }, WAIT);
    for (const name of [A.table.columns.errorRate, A.table.columns.errors]) {
      const link = target(screen.getByRole('link', { name }));
      expect(link.pathname).toBe('/analytics/search');
      expect(link.searchParams.get('q')).toBe('status:>=400');
    }
  });

  it('opens the API and key lists from the active counts', async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByRole('link', { name: A.overview.activeApis }, WAIT);
    expect(screen.getByRole('link', { name: A.overview.activeApis }).getAttribute('href')).toBe('/apis');
    expect(screen.getByRole('link', { name: A.overview.activeKeys }).getAttribute('href')).toBe('/keys');
  });

  it('leaves out the links to lists the user may not open', async () => {
    granted = ['analytics:read'];
    renderApp(<AnalyticsPage />);
    await screen.findByRole('link', { name: A.overview.totalRequests }, WAIT);
    for (const name of [A.overview.activeApis, A.overview.activeKeys, A.table.columns.errorRate]) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
  });
});

describe('analytics page click-through: the tables', () => {
  it("opens an API's traffic from its row, request count and name link to the API itself", async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByText('Orders API', { selector: 'a' }, WAIT);
    const row = rowOf('Orders API');
    expect(within(row).getByRole('link', { name: 'Orders API' }).getAttribute('href')).toBe(`/apis/${ORDERS}`);
    const requests = target(within(row).getByRole('link', { name: 'View traffic for Orders API 1,200' }));
    expect(requests.pathname).toBe('/analytics/traffic');
    expect(requests.searchParams.get('apiId')).toBe(ORDERS);
    expect(target(rowLink(row)).searchParams.get('apiId')).toBe(ORDERS);
  });

  it("opens an API's failed requests from its error count, and only when it has some", async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByText('Orders API', { selector: 'a' }, WAIT);
    const errors = target(
      within(rowOf('Orders API')).getByRole('link', { name: 'View failed requests for Orders API 48' }),
    );
    expect(errors.pathname).toBe('/analytics/search');
    expect(errors.searchParams.get('q')).toBe(`api:${ORDERS} status:>=400`);
    expect(within(rowOf('Quiet API')).queryByRole('link', { name: /View failed requests/ })).toBeNull();
  });

  it("opens a key's traffic from its row and request count, and the key itself from its name", async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByText('qbus-web', { selector: 'a' }, WAIT);
    const row = rowOf('qbus-web');
    expect(within(row).getByRole('link', { name: 'qbus-web' }).getAttribute('href')).toBe(`/keys/${KEY_ID}`);
    expect(
      target(within(row).getByRole('link', { name: 'View traffic for qbus-web 700' })).searchParams.get('keyId'),
    ).toBe(KEY_ID);
    expect(target(rowLink(row)).searchParams.get('keyId')).toBe(KEY_ID);
  });

  it("opens a key's failed requests from its error count, by the key's name", async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByText('qbus-web', { selector: 'a' }, WAIT);
    const errors = target(
      within(rowOf('qbus-web')).getByRole('link', { name: 'View failed requests for qbus-web 14' }),
    );
    expect(errors.searchParams.get('q')).toBe('key:qbus-web status:>=400');
  });

  it("has no failed-requests link for a key whose name another key shares: a `key:` search would list both keys' requests", async () => {
    const row = (apiKeyId: string, name: string, errors: number) => ({
      apiKeyId, name, status: 'ACTIVE', apiDefName: 'Orders API', requests: 100, errors, errorRate: errors, avgLatencyMs: 90,
    });
    mockFetch((call) => {
      if (call.path.startsWith('/analytics/health')) return ok(health);
      if (call.path.startsWith('/analytics/overview')) return ok(overview);
      if (call.path.startsWith('/analytics/apis')) return ok(apiRows);
      if (call.path.startsWith('/analytics/keys')) {
        return ok([row(KEY_ID, 'qbus-web', 14), row('k-twin-1', 'mobile-app', 5), row('k-twin-2', 'mobile-app', 7)]);
      }
      if (call.path.startsWith('/analytics/status-codes')) return ok(statusCodes);
      return ok([]);
    });
    renderApp(<AnalyticsPage />);
    await screen.findByText('qbus-web', { selector: 'a' }, WAIT);
    expect(screen.getByRole('link', { name: 'View failed requests for qbus-web 14' })).toBeDefined();
    expect(screen.queryAllByRole('link', { name: /View failed requests for mobile-app/ })).toHaveLength(0);
    // Their traffic is found by id, so those links are not ambiguous and stay.
    expect(screen.getAllByRole('link', { name: /View traffic for mobile-app/ })).toHaveLength(2);
  });

  it('keeps the traffic links but drops the search ones when the user cannot open search', async () => {
    granted = ['analytics:read', 'api:read', 'key:read'];
    renderApp(<AnalyticsPage />);
    await screen.findByText('Orders API', { selector: 'a' }, WAIT);
    expect(within(rowOf('Orders API')).queryByRole('link', { name: /View failed requests/ })).toBeNull();
    expect(within(rowOf('Orders API')).getByRole('link', { name: 'View traffic for Orders API 1,200' })).toBeDefined();
  });
});

describe('analytics page click-through: the tables, for assistive technology and selection', () => {
  it('names each row by its API or key, as a row header', async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByText('Orders API', { selector: 'a' }, WAIT);
    expect(screen.getByRole('rowheader', { name: /Orders API/ }).tagName).toBe('TH');
    expect(screen.getByRole('rowheader', { name: /qbus-web/ }).tagName).toBe('TH');
  });

  it('shows a name as plain text, not a link to a page it may not open, and the figures still say whose they are', async () => {
    granted = ['analytics:read', 'api:update'];
    renderApp(<AnalyticsPage />);
    const header = await screen.findByRole('rowheader', { name: /Orders API/ }, WAIT);
    const row = header.closest('tr') as HTMLElement;
    expect(within(row).queryByRole('link', { name: 'Orders API' })).toBeNull();
    expect(within(row).getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/apis/'))).toBe(false);
    expect(within(row).getByRole('link', { name: 'View traffic for Orders API 1,200' })).toBeDefined();
    const keyRow = screen.getByRole('rowheader', { name: /qbus-web/ }).closest('tr') as HTMLElement;
    expect(within(keyRow).queryByRole('link', { name: 'qbus-web' })).toBeNull();
    expect(within(keyRow).getByRole('link', { name: 'View traffic for qbus-web 700' })).toBeDefined();
  });

  it('follows a row\'s hidden link when its text is clicked, and not when it is double-clicked', async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByText('Orders API', { selector: 'a' }, WAIT);
    const row = rowOf('Orders API');
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    rowLink(row).addEventListener('click', clicked);
    const slug = within(row).getByText('orders');
    withRowClock((pass) => {
      fireEvent.click(slug, { detail: 1 });
      fireEvent.click(slug, { detail: 2 });
      pass();
      expect(clicked).not.toHaveBeenCalled();
      fireEvent.click(slug, { detail: 1 });
      expect(clicked).not.toHaveBeenCalled();
      pass();
      expect(clicked).toHaveBeenCalledTimes(1);
    });
  });
});

describe('analytics page click-through: status codes', () => {
  it('lists every status with its count as a link to the requests that have it', async () => {
    renderApp(<AnalyticsPage />);
    const nav = await screen.findByRole('navigation', { name: A.charts.statusCodes.browse }, WAIT);
    const q = (name: RegExp) => target(within(nav).getByRole('link', { name })).searchParams.get('q');
    expect(q(/^2xx/)).toBe('status:2xx');
    expect(q(/^401/)).toBe('status:401');
    expect(q(/^503/)).toBe('status:503');
  });

  it('opens a remainder bucket without the codes the breakdown lists on their own', async () => {
    renderApp(<AnalyticsPage />);
    const nav = await screen.findByRole('navigation', { name: A.charts.statusCodes.browse }, WAIT);
    const q = (name: RegExp) => target(within(nav).getByRole('link', { name })).searchParams.get('q');
    expect(q(/^4xx/)).toBe('status:4xx -status:400,401,403,404,429');
    expect(q(/^5xx/)).toBe('status:5xx -status:500,502,503,504');
  });

  it('has no status links for someone who cannot open search', async () => {
    granted = ['analytics:read'];
    renderApp(<AnalyticsPage />);
    await screen.findByRole('link', { name: A.overview.totalRequests }, WAIT);
    expect(screen.queryByRole('navigation', { name: A.charts.statusCodes.browse })).toBeNull();
  });

  it('opens the requests of a status when its bar is clicked', async () => {
    renderApp(<AnalyticsPage />);
    await screen.findByRole('navigation', { name: A.charts.statusCodes.browse }, WAIT);
    await waitFor(() => {
      expect(document.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0);
    }, WAIT);
    // The first bar of the first stack is the success class of the first row, "2xx".
    const bar = document.querySelector('.recharts-bar-rectangle path, .recharts-bar-rectangle');
    if (!bar) throw new Error('no bar drawn');
    fireEvent.click(bar);
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0]?.[0])).toBe('/analytics/search?q=status%3A2xx');
  });
});
