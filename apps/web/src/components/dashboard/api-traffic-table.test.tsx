// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { ApiTrafficTable } from './api-traffic-table';
import { renderApp, withRowClock } from './test-render';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const ORDERS = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const BILLING = '7a2d3e4f-5b6c-4d7e-9f80-1b2c3d4e5f60';
const row = (apiDefId: string, name: string, over: Record<string, unknown> = {}) => ({
  apiDefId,
  name,
  slug: name.toLowerCase(),
  status: 'ACTIVE',
  requests: 1_200,
  errors: 48,
  errorRate: 4,
  avgLatencyMs: 120,
  ...over,
});
const WAIT = { timeout: 8000 };
const href = (el: HTMLElement) => el.getAttribute('href');

beforeEach(() => {
  granted = ['analytics:read', 'api:update', 'api:read'];
  mockFetch(() =>
    ok([row(ORDERS, 'Orders'), row(BILLING, 'Billing', { requests: 90, errors: 0, errorRate: 0 })]),
  );
});

describe('ApiTrafficTable click-through', () => {
  it("gives each row a hidden link to that API's traffic for the range, which the row's click follows", async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const hidden = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(hidden.map((a) => a.getAttribute('href'))).toEqual([
      `/analytics/traffic?apiId=${ORDERS}&range=7d`,
      `/analytics/traffic?apiId=${BILLING}&range=7d`,
    ]);
    // Hidden, out of the tab order, unannounced, and taking no space: the row's text can be selected.
    expect(hidden.every((a) => a.hidden && a.getAttribute('aria-hidden') === 'true' && a.tabIndex === -1)).toBe(true);
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    hidden[0]?.addEventListener('click', clicked);
    fireEvent.click(screen.getByText('orders'), { detail: 1 });
    await waitFor(() => {
      expect(clicked).toHaveBeenCalledTimes(1);
    }, WAIT);
  });

  it('does not follow the row when its text is double-clicked to select a word', async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    document.querySelector('a[data-row-link]')?.addEventListener('click', clicked);
    const slug = screen.getByText('orders');
    withRowClock((pass) => {
      fireEvent.click(slug, { detail: 1 });
      fireEvent.click(slug, { detail: 2 });
      pass();
      expect(clicked).not.toHaveBeenCalled();
    });
  });

  it("names the row by its API: a row header, and the keyboard's links say which API they are for", async () => {
    renderApp(<ApiTrafficTable range="24h" />);
    await screen.findByText('Orders', undefined, WAIT);
    const header = screen.getByRole('rowheader', { name: /Orders/ });
    expect(header.tagName).toBe('TH');
    const orders = header.closest('tr') as HTMLElement;
    expect(href(within(orders).getByRole('link', { name: 'Orders' }))).toBe(`/apis/${ORDERS}`);
    const traffic = within(orders).getByRole('link', { name: 'View traffic for Orders 1.2K' });
    expect(href(traffic)).toBe(`/analytics/traffic?apiId=${ORDERS}`);
  });

  it("keeps the API name link as wide as the name, so empty space beside it does not open the API", async () => {
    renderApp(<ApiTrafficTable range="24h" />);
    await screen.findByText('Orders', undefined, WAIT);
    const name = screen.getByRole('link', { name: 'Orders' });
    expect(name.className).not.toMatch(/(^|\s)block(\s|$)/);
    expect(name.className).toContain('inline-block');
  });

  it("opens that API's failed requests from the error rate (errors are status 400 and up), saying whose they are", async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const orders = screen.getByRole('rowheader', { name: /Orders/ }).closest('tr') as HTMLElement;
    const link = within(orders).getByRole('link', { name: /View failed requests for Orders.*4\.0\s?%/ });
    const target = new URL(href(link) ?? '', 'http://x');
    expect(target.pathname).toBe('/analytics/search');
    expect(target.searchParams.get('q')).toBe(`api:${ORDERS} status:>=400`);
    expect(target.searchParams.get('range')).toBe('7d');
  });

  it('has no failed-requests link for an API without errors', async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Billing', undefined, WAIT);
    const billing = screen.getByRole('rowheader', { name: /Billing/ }).closest('tr') as HTMLElement;
    const hrefs = within(billing).queryAllByRole('link').map(href);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.some((h) => h?.includes('/analytics/search'))).toBe(false);
  });

  it('drops the search link when search is closed to the user, keeping the traffic links', async () => {
    granted = ['analytics:read', 'api:read'];
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const orders = screen.getByRole('rowheader', { name: /Orders/ }).closest('tr') as HTMLElement;
    expect(within(orders).queryByRole('link', { name: /View failed requests/ })).toBeNull();
    expect(within(orders).getByRole('link', { name: /View traffic for Orders/ })).toBeDefined();
  });

  it('shows the API name as plain text, not a link to a page it may not open, without api:read; the figures still say whose they are', async () => {
    granted = ['analytics:read', 'api:update'];
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const orders = screen.getByRole('rowheader', { name: /Orders/ }).closest('tr') as HTMLElement;
    expect(within(orders).queryByRole('link', { name: 'Orders' })).toBeNull();
    expect(within(orders).getAllByRole('link').some((a) => href(a)?.startsWith('/apis/'))).toBe(false);
    // The number links name their API in their own text, since the name is no longer a link beside them.
    expect(within(orders).getByRole('link', { name: 'View traffic for Orders 1.2K' })).toBeDefined();
  });

  it('still narrows the dashboard from the focus button, without following the row', async () => {
    const onSelect = vi.fn();
    renderApp(<ApiTrafficTable range="7d" onSelect={onSelect} />);
    await screen.findByText('Orders', undefined, WAIT);
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    document.querySelector('a[data-row-link]')?.addEventListener('click', clicked);
    withRowClock((pass) => {
      fireEvent.click(screen.getByRole('button', { name: 'Show only Orders' }), { detail: 1 });
      pass();
      expect(onSelect).toHaveBeenCalledWith(ORDERS);
      expect(clicked).not.toHaveBeenCalled();
    });
  });
});

describe('ApiTrafficTable layout guards', () => {
  const LONG = 'OrdersGatewayApiV'.repeat(7).slice(0, 100);

  it('positions its scroller, so the sr-only texts inside it are clipped by it and cannot widen the page', async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const scroller = document.querySelector('.overflow-x-auto');
    if (!scroller) throw new Error('no scroller');
    expect(scroller.querySelector('.sr-only')).not.toBeNull();
    // An absolutely positioned child escapes the clip of a scroller that is not itself positioned.
    expect(scroller.className.split(' ')).toContain('relative');
  });

  it('caps a long unbroken name, cut with an ellipsis and whole in its tooltip, so it cannot push the other columns away', async () => {
    mockFetch(() => ok([row(ORDERS, LONG), row(BILLING, 'Billing')]));
    renderApp(<ApiTrafficTable range="7d" />);
    const name = await screen.findByText(LONG, { selector: 'a' }, WAIT);
    expect(name.getAttribute('title')).toBe(LONG);
    expect(name.className).toContain('truncate');
    // The name column takes what the figures leave (`w-full max-w-0`) rather than the width of its widest name.
    expect(name.closest('th')?.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'max-w-0']));
  });

  it('keeps every figure on one line, so the name is what gives way when the card is narrow', async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    const cells = Array.from(screen.getByRole('rowheader', { name: /Orders/ }).closest('tr')?.querySelectorAll('td') ?? []);
    expect(cells).toHaveLength(4);
    expect(cells.slice(0, 3).every((cell) => cell.className.split(' ').includes('whitespace-nowrap'))).toBe(true);
  });

  it('does not force a table wider than the card holds: its minimum is the figures, not a fixed 40rem', async () => {
    renderApp(<ApiTrafficTable range="7d" />);
    await screen.findByText('Orders', undefined, WAIT);
    expect(document.querySelector('.overflow-x-auto table')?.className).toContain('min-w-[28rem]');
  });

  it('does the same for a name that is not a link', async () => {
    granted = ['analytics:read'];
    mockFetch(() => ok([row(ORDERS, LONG)]));
    renderApp(<ApiTrafficTable range="7d" />);
    const name = await screen.findByText(LONG, { selector: 'span' }, WAIT);
    expect(name.getAttribute('title')).toBe(LONG);
    expect(name.className).toContain('truncate');
  });
});
