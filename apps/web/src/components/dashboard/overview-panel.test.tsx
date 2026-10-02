// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { OverviewPanel } from './overview-panel';
import { renderApp } from './test-render';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
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
  range: '7d',
  generatedAt: '2026-09-29T10:00:00.000Z',
};
const statusCodes = [
  { code: '2xx', count: 89_000 },
  { code: '404', count: 600 },
  { code: '503', count: 400 },
];
const scopedTraffic = {
  range: '7d',
  summary: {
    requests: 5_000,
    requestsPerSecond: 0.06,
    errors: 50,
    errorRate: 1,
    clientErrors: 30,
    serverErrors: 20,
    avgLatencyMs: 110,
    avgUpstreamLatencyMs: 90,
    p50LatencyMs: 80,
    p95LatencyMs: 300,
    p99LatencyMs: 700,
    uniqueClients: 9,
    uniqueKeys: 3,
    anonymousShare: 0,
    bytesIn: 1,
    lastRequestAt: '2026-09-29T10:00:00.000Z',
  },
  statusCodes: [
    { code: 200, count: 4_950 },
    { code: 503, count: 50 },
  ],
};
const WAIT = { timeout: 8000 };
const href = (name: string | RegExp) => screen.getByRole('link', { name }).getAttribute('href');

beforeEach(() => {
  granted = ['analytics:read', 'api:update'];
  mockFetch((call) => {
    if (call.path.startsWith('/analytics/overview')) return ok(overview);
    if (call.path.startsWith('/analytics/status-codes')) return ok(statusCodes);
    if (call.path.startsWith('/analytics/traffic')) return ok(scopedTraffic);
    return ok([]);
  });
});

describe('OverviewPanel click-through', () => {
  it('opens the traffic view for the range from the request and latency figures', async () => {
    renderApp(<OverviewPanel range="7d" />);
    await screen.findByRole('link', { name: 'Total requests' }, WAIT);
    expect(href('Total requests')).toBe('/analytics/traffic?range=7d');
    expect(href('Avg latency')).toBe('/analytics/traffic?range=7d');
  });

  it('opens the failed requests (status 400 and up, which is how errors are counted) from the errors figure', async () => {
    renderApp(<OverviewPanel range="7d" />);
    await screen.findByRole('link', { name: '1,000 errors' }, WAIT);
    expect(href('1,000 errors')).toBe('/analytics/search?q=status%3A%3E%3D400&range=7d');
  });

  it('opens one status class from its share in the status mix', async () => {
    renderApp(<OverviewPanel range="24h" />);
    await screen.findByRole('link', { name: /4xx/ }, WAIT);
    expect(href(/4xx/)).toBe('/analytics/search?q=status%3A4xx');
    expect(href(/5xx/)).toBe('/analytics/search?q=status%3A5xx');
    expect(href(/2xx/)).toBe('/analytics/search?q=status%3A2xx');
  });

  it('says what each share is a link to: "View requests with status 4xx 0.7%", not a bare "4xx 0.7%"', async () => {
    renderApp(<OverviewPanel range="24h" />);
    const link = await screen.findByRole('link', { name: /4xx/ }, WAIT);
    expect(link.textContent).toMatch(/^View requests with status 4xx/);
  });

  it('shows the error count as plain text when there are none: nothing to open', async () => {
    mockFetch((call) => {
      if (call.path.startsWith('/analytics/overview')) return ok({ ...overview, errorCount: 0, errorRate: 0 });
      if (call.path.startsWith('/analytics/status-codes')) return ok(statusCodes);
      return ok([]);
    });
    renderApp(<OverviewPanel range="7d" />);
    await screen.findByRole('link', { name: 'Total requests' }, WAIT);
    expect(screen.getByText('0 errors')).toBeDefined();
    expect(screen.queryByRole('link', { name: '0 errors' })).toBeNull();
  });

  it('narrows every link to the API the panel is scoped to', async () => {
    renderApp(<OverviewPanel range="7d" scope={{ id: API_ID, name: 'Orders API' }} />);
    await screen.findByRole('link', { name: 'Total requests' }, WAIT);
    expect(href('Total requests')).toBe(`/analytics/traffic?apiId=${API_ID}&range=7d`);
    const errors = new URL(href(/errors$/) ?? '', 'http://x');
    expect(errors.searchParams.get('q')).toBe(`api:${API_ID} status:>=400`);
    const mix = new URL(href(/5xx/) ?? '', 'http://x');
    expect(mix.searchParams.get('q')).toBe(`api:${API_ID} status:5xx`);
  });

  it('keeps the traffic links but drops the search ones for someone who cannot open search', async () => {
    granted = ['analytics:read'];
    renderApp(<OverviewPanel range="7d" />);
    await screen.findByRole('link', { name: 'Total requests' }, WAIT);
    expect(screen.queryByRole('link', { name: '1,000 errors' })).toBeNull();
    expect(screen.queryByRole('link', { name: /5xx/ })).toBeNull();
    // The figures are still shown, as text.
    expect(screen.getByText('1,000 errors')).toBeDefined();
  });
});
