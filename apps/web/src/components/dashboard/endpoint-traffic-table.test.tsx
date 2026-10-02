// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { EndpointTrafficTable } from './endpoint-traffic-table';
import { renderApp, withRowClock } from './test-render';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const endpoint = (method: string, path: string, over: Record<string, unknown> = {}) => ({
  method,
  path,
  requests: 700,
  errors: 21,
  errorRate: 3,
  avgLatencyMs: 90,
  p95LatencyMs: 200,
  ...over,
});
const traffic = {
  range: '7d',
  summary: { requests: 1_000, errors: 0, errorRate: 0, uniqueKeys: 1 },
  statusCodes: [],
  topEndpoints: [endpoint('GET', '/v1/orders'), endpoint('POST', '/v1/orders', { errors: 0, errorRate: 0 })],
};
const WAIT = { timeout: 8000 };
const SCOPE = { id: API_ID, name: 'Orders API' };
const target = (el: HTMLElement) => new URL(el.getAttribute('href') ?? '', 'http://x');

beforeEach(() => {
  granted = ['analytics:read', 'api:update'];
  mockFetch(() => ok(traffic));
});

describe('EndpointTrafficTable click-through', () => {
  it("gives each row a hidden link to the endpoint's traffic (API, method and path), and the path is the keyboard's link to the same place", async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const hidden = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(hidden).toHaveLength(2);
    expect(hidden.every((a) => a.hidden && a.getAttribute('aria-hidden') === 'true' && a.tabIndex === -1)).toBe(true);
    const expected = { apiId: API_ID, method: 'GET', path: '/v1/orders', range: '7d' };
    expect(Object.fromEntries(target(hidden[0] as HTMLElement).searchParams)).toEqual(expected);
    // The link's name carries the method (the badge beside it is not part of the link), so a list of
    // links reads "GET /v1/orders", "POST /v1/orders" rather than the same path twice.
    const get = screen.getByRole('rowheader', { name: /GET.*\/v1\/orders/ }).closest('tr') as HTMLElement;
    const pathLink = within(get).getByRole('link', { name: 'GET /v1/orders' });
    expect(Object.fromEntries(target(pathLink).searchParams)).toEqual(expected);
    expect(screen.getByRole('link', { name: 'POST /v1/orders' })).toBeDefined();
  });

  it('follows the row link when the row is clicked, and not when its text is double-clicked', async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const hidden = document.querySelector('a[data-row-link]');
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    hidden?.addEventListener('click', clicked);
    const cell = screen.getAllByText('700')[0];
    if (!cell) throw new Error('no 700 cell');
    withRowClock((pass) => {
      fireEvent.click(cell, { detail: 1 });
      fireEvent.click(cell, { detail: 2 });
      pass();
      expect(clicked).not.toHaveBeenCalled();
      fireEvent.click(cell, { detail: 1 });
      pass();
      expect(clicked).toHaveBeenCalledTimes(1);
    });
  });

  it("opens that endpoint's failed requests from its error rate, saying whose they are", async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const get = screen.getByRole('rowheader', { name: /GET.*\/v1\/orders/ }).closest('tr') as HTMLElement;
    const link = within(get).getByRole('link', { name: /View failed requests for GET \/v1\/orders.*3\.0\s?%/ });
    const errors = target(link);
    expect(errors.pathname).toBe('/analytics/search');
    // `route:` is the endpoint's exact path (the row counts exactly this one), where `path:` is a prefix.
    expect(errors.searchParams.get('q')).toBe(`api:${API_ID} route:/v1/orders method:GET status:>=400`);
    expect(errors.searchParams.get('range')).toBe('7d');
  });

  it('has no failed-requests link for an endpoint without errors', async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const post = screen.getByRole('rowheader', { name: /POST.*\/v1\/orders/ }).closest('tr') as HTMLElement;
    expect(within(post).queryByRole('link', { name: /View failed requests/ })).toBeNull();
  });

  it('has no failed-requests link for an endpoint whose path search cannot write, but still links its traffic', async () => {
    mockFetch(() => ok({ ...traffic, topEndpoints: [endpoint('GET', '/v1/say"hi"')] }));
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/say"hi"', undefined, WAIT);
    const row = screen.getByRole('rowheader', { name: /GET.*say/ }).closest('tr') as HTMLElement;
    // A link that dropped the path would list every endpoint's failures. Plain text: not even an anchor without an address.
    expect(within(row).queryByRole('link', { name: /View failed requests/ })).toBeNull();
    expect(within(row).getByText(/3\.0\s?%/).closest('a')).toBeNull();
    expect(target(within(row).getByRole('link', { name: 'GET /v1/say"hi"' })).pathname).toBe('/analytics/traffic');
  });

  it('keeps the traffic links but not the search ones when search is closed to the user', async () => {
    granted = ['analytics:read'];
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const get = screen.getByRole('rowheader', { name: /GET.*\/v1\/orders/ }).closest('tr') as HTMLElement;
    expect(within(get).getByRole('link', { name: 'GET /v1/orders' })).toBeDefined();
    expect(within(get).queryByRole('link', { name: /View failed requests/ })).toBeNull();
  });
});

describe('EndpointTrafficTable layout guards', () => {
  const LONG_PATH = `/v1/${'a1b2c3d4'.repeat(15)}`;

  it('positions its scroller, so the sr-only texts inside it are clipped by it and cannot widen the page', async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const scroller = document.querySelector('.overflow-x-auto');
    if (!scroller) throw new Error('no scroller');
    expect(scroller.querySelector('.sr-only')).not.toBeNull();
    expect(scroller.className.split(' ')).toContain('relative');
  });

  it('caps a long unbroken path, cut with an ellipsis and whole in its tooltip, so it cannot push the other columns away', async () => {
    mockFetch(() => ok({ ...traffic, topEndpoints: [endpoint('GET', LONG_PATH), endpoint('POST', '/v1/orders')] }));
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    const link = await screen.findByRole('link', { name: `GET ${LONG_PATH}` }, WAIT);
    expect(link.getAttribute('title')).toBe(LONG_PATH);
    expect(link.className).toContain('truncate');
    // The path column takes what the figures leave (`w-full max-w-0`) rather than the width of its widest path.
    expect(link.closest('th')?.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'max-w-0']));
  });

  it('keeps every figure on one line, so the path is what gives way when the card is narrow', async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const cells = Array.from(document.querySelector('tbody tr')?.querySelectorAll('td') ?? []);
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.className.split(' ').includes('whitespace-nowrap'))).toBe(true);
  });

  it('does not force a table wider than the card holds: its minimum is the figures, not a fixed 40rem', async () => {
    renderApp(<EndpointTrafficTable range="7d" scope={SCOPE} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    expect(document.querySelector('.overflow-x-auto table')?.className).toContain('min-w-[28rem]');
  });
});
