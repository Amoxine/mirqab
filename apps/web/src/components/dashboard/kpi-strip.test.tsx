// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import dashboard from '@/messages/en/dashboard.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { KpiStrip } from './kpi-strip';
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
/** What `/analytics/traffic` answers for one API: only `summary` is read by the strip. */
const scopedTraffic = {
  range: '24h',
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
};
const WAIT = { timeout: 8000 };
const K = dashboard.kpis;
const hrefOf = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

beforeEach(() => {
  granted = ['analytics:read', 'api:read', 'key:read'];
  mockFetch((call) => {
    if (call.path.startsWith('/analytics/overview')) return ok(overview);
    if (call.path.startsWith('/analytics/traffic')) return ok(scopedTraffic);
    return ok([]);
  });
});

describe('KpiStrip click-through', () => {
  it('opens the traffic view for the same range from the throughput and latency figures', async () => {
    renderApp(<KpiStrip range="7d" showNodes={false} />);
    await screen.findByRole('link', { name: K.throughput }, WAIT);
    expect(hrefOf(K.throughput)).toBe('/analytics/traffic?range=7d');
    expect(hrefOf(K.p95)).toBe('/analytics/traffic?range=7d');
    expect(hrefOf(K.p99)).toBe('/analytics/traffic?range=7d');
    expect(hrefOf(K.openTraffic)).toBe('/analytics/traffic?range=7d');
  });

  it('carries the API the dashboard is narrowed to into the traffic filters', async () => {
    renderApp(<KpiStrip range="24h" showNodes={false} apiId={API_ID} />);
    await screen.findByRole('link', { name: K.p95 }, WAIT);
    expect(hrefOf(K.p95)).toBe(`/analytics/traffic?apiId=${API_ID}`);
  });

  it('sends the active-APIs figure to the API list and its keys count to the key list, as two separate links', async () => {
    const { container } = renderApp(<KpiStrip range="24h" showNodes={false} />);
    await screen.findByRole('link', { name: K.apis }, WAIT);
    expect(hrefOf(K.apis)).toBe('/apis');
    expect(hrefOf('7 active keys')).toBe('/keys');
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });

  it('sends the narrowed dashboard\'s API figure to that API, with no key list link', async () => {
    renderApp(<KpiStrip range="24h" showNodes={false} apiId={API_ID} />);
    await screen.findByRole('link', { name: K.apis }, WAIT);
    expect(hrefOf(K.apis)).toBe(`/apis/${API_ID}`);
    expect(screen.queryByRole('link', { name: /active keys/ })).toBeNull();
  });

  it('does not link a figure to a list the user may not open', async () => {
    granted = ['analytics:read'];
    renderApp(<KpiStrip range="24h" showNodes={false} />);
    await screen.findByRole('link', { name: K.p95 }, WAIT);
    expect(screen.queryByRole('link', { name: K.apis })).toBeNull();
    expect(screen.queryByRole('link', { name: /active keys/ })).toBeNull();
    // The figures themselves are still there.
    expect(screen.getByText('4')).toBeDefined();
  });
});
