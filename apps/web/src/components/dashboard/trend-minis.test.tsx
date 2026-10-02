// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import dashboard from '@/messages/en/dashboard.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { ErrorsMini, LatencyMini } from './trend-minis';
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
const WAIT = { timeout: 8000 };
const linkTo = (title: string) => screen.getByRole('link', { name: `Open analytics for ${title}` });
const D = dashboard;

beforeEach(() => {
  granted = ['analytics:read', 'api:update'];
  mockFetch((call) => ok(call.path.startsWith('/analytics/overview') ? overview : []));
});

describe('trend minis click-through', () => {
  it("opens the traffic view for the range from the latency card", async () => {
    renderApp(<LatencyMini range="7d" />);
    await screen.findByRole('link', { name: `Open analytics for ${D.latency.title}` }, WAIT);
    expect(linkTo(D.latency.title).getAttribute('href')).toBe('/analytics/traffic?range=7d');
  });

  it('opens the failed requests (status 400 and up) from the error card', async () => {
    renderApp(<ErrorsMini range="7d" />);
    const link = await screen.findByRole('link', { name: D.errors.openFailed }, WAIT);
    expect(link.getAttribute('href')).toBe('/analytics/search?q=status%3A%3E%3D400&range=7d');
  });

  it('narrows both to the API the dashboard is narrowed to', async () => {
    renderApp(<ErrorsMini range="24h" apiId={API_ID} />);
    const link = await screen.findByRole('link', { name: D.errors.openFailed }, WAIT);
    expect(new URL(link.getAttribute('href') ?? '', 'http://x').searchParams.get('q')).toBe(
      `api:${API_ID} status:>=400`,
    );
  });

  it('falls back to the traffic view when the user cannot open search', async () => {
    granted = ['analytics:read'];
    renderApp(<ErrorsMini range="7d" />);
    const link = await screen.findByRole('link', { name: `Open analytics for ${D.errors.title}` }, WAIT);
    expect(link.getAttribute('href')).toBe('/analytics/traffic?range=7d');
  });
});
