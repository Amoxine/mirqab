// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { TopApisCard } from './top-apis-card';
import { renderApp } from './test-render';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const ORDERS = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const BILLING = '7a2d3e4f-5b6c-4d7e-9f80-1b2c3d4e5f60';
const apiRow = (apiDefId: string, name: string, slug: string, requests: number) => ({
  apiDefId,
  name,
  slug,
  status: 'ACTIVE',
  requests,
  errors: 0,
  errorRate: 0,
  avgLatencyMs: 100,
});
const overview = { totalRequests: 1_000, errorCount: 0, errorRate: 0, activeApis: 2, activeKeys: 1 };
const traffic = {
  range: '7d',
  summary: { requests: 1_000, errors: 0, errorRate: 0, uniqueKeys: 1 },
  statusCodes: [],
  topEndpoints: [
    { method: 'GET', path: '/orders', requests: 700, errors: 0, errorRate: 0, avgLatencyMs: 90, p95LatencyMs: 200 },
    { method: 'POST', path: '/orders', requests: 300, errors: 0, errorRate: 0, avgLatencyMs: 90, p95LatencyMs: 200 },
  ],
};
const WAIT = { timeout: 8000 };
const url = (href: string | null) => new URL(href ?? '', 'http://x');

beforeEach(() => {
  granted = ['api:read'];
  mockFetch((call) => {
    if (call.path.startsWith('/analytics/apis')) {
      return ok([apiRow(ORDERS, 'Orders API', 'orders', 700), apiRow(BILLING, 'Billing API', 'billing', 300)]);
    }
    if (call.path.startsWith('/analytics/overview')) return ok(overview);
    if (call.path.startsWith('/analytics/traffic')) return ok(traffic);
    return ok([]);
  });
});

describe('TopApisCard click-through', () => {
  it("opens an API's traffic from its bar, and keeps a second link to the API itself", async () => {
    renderApp(<TopApisCard range="7d" />);
    const traffic = await screen.findByRole('link', { name: /View traffic for Orders API/ }, WAIT);
    expect(traffic.getAttribute('href')).toBe(`/analytics/traffic?apiId=${ORDERS}&range=7d`);
    expect(screen.getByRole('link', { name: 'Orders API' }).getAttribute('href')).toBe(`/apis/${ORDERS}`);
    expect(screen.getByRole('link', { name: /View traffic for Billing API/ }).getAttribute('href')).toBe(
      `/analytics/traffic?apiId=${BILLING}&range=7d`,
    );
  });

  it("keeps the API's own link out of the card for someone who may not open APIs: a link to a page they cannot enter", async () => {
    granted = [];
    renderApp(<TopApisCard range="7d" />);
    const orders = await screen.findByRole('link', { name: /View traffic for Orders API/ }, WAIT);
    // Its traffic stays a link (traffic is a different permission), and the name is plain text.
    expect(orders.getAttribute('href')).toBe(`/analytics/traffic?apiId=${ORDERS}&range=7d`);
    expect(screen.queryByRole('link', { name: 'Orders API' })).toBeNull();
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/apis/'))).toBe(false);
    expect(screen.getByText('Orders API', { selector: 'span' })).toBeDefined();
  });

  it('names the bar link with a real space between what it opens and its count', async () => {
    renderApp(<TopApisCard range="7d" />);
    const link = await screen.findByRole('link', { name: /View traffic for Orders API/ }, WAIT);
    expect(link.textContent).toMatch(/Orders API.* 700$/);
  });

  it("opens the narrowed API's traffic from the card's arrow, in the same range", async () => {
    renderApp(<TopApisCard range="7d" scope={{ id: ORDERS, name: 'Orders API' }} />);
    await screen.findByRole('link', { name: /View traffic for GET \/orders/ }, WAIT);
    const arrow = screen.getByRole('link', { name: 'Open analytics' });
    expect(url(arrow.getAttribute('href')).pathname).toBe('/analytics/traffic');
    expect(Object.fromEntries(url(arrow.getAttribute('href')).searchParams)).toEqual({ apiId: ORDERS, range: '7d' });
  });

  it('gives its links an outline that survives forced colours', async () => {
    const { container } = renderApp(<TopApisCard range="7d" />);
    await screen.findByRole('link', { name: 'Orders API' }, WAIT);
    expect(container.innerHTML).not.toContain('focus-visible:outline-none');
    expect(screen.getByRole('link', { name: 'Orders API' }).className).toContain('focus-visible:outline-hidden');
  });

  it('never nests one link inside another', async () => {
    const { container } = renderApp(<TopApisCard range="7d" />);
    await screen.findByRole('link', { name: /View traffic for Orders API/ }, WAIT);
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });

  it("opens one endpoint's traffic (its method and path, in that API) when the card is narrowed to an API", async () => {
    renderApp(<TopApisCard range="7d" scope={{ id: ORDERS, name: 'Orders API' }} />);
    const get = await screen.findByRole('link', { name: /View traffic for GET \/orders/ }, WAIT);
    const target = url(get.getAttribute('href'));
    expect(target.pathname).toBe('/analytics/traffic');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      apiId: ORDERS,
      method: 'GET',
      path: '/orders',
      range: '7d',
    });
    const post = screen.getByRole('link', { name: /View traffic for POST \/orders/ });
    expect(url(post.getAttribute('href')).searchParams.get('method')).toBe('POST');
  });
});
