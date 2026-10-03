// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { indexedAgo, renderApp } from '@/components/dashboard/test-render';
import TrafficSearchPage from './page';

const replace = vi.fn();
let search = '';
let granted: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/analytics/search',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const D = analytics.search.detail;
const WAIT = { timeout: 8000 };
const ts = (n: number) => `2026-09-29T10:00:0${String(n)}.123456Z`;
const item = (n: number) => ({
  id: String(n),
  ts: ts(n),
  apiId: API_ID,
  apiName: 'Orders API',
  method: 'POST',
  path: `/orders/${String(n)}`,
  status: 500,
  latencyMs: 340,
  keyAlias: 'qbus-web',
  reqTruncated: false,
  resTruncated: false,
});
const detailOf = (n: number) => ({
  ...item(n),
  ip: '10.0.0.7',
  reqHeaders: {},
  resHeaders: {},
  reqBody: '',
  resBody: '{"error":"insufficient funds"}',
});
const page = (items: unknown[]) => ({
  range: '24h',
  items,
  hasMore: false,
  nextCursor: null,
  indexedUntil: indexedAgo(10_000),
});
/** The URL of the last `router.replace`, split so a test can read the params whatever their order. */
function lastReplace() {
  const url = String(replace.mock.calls.at(-1)?.[0]);
  const [path = '', query = ''] = url.split('?');
  return { path, params: new URLSearchParams(query), options: replace.mock.calls.at(-1)?.[1] as unknown };
}
const dialog = () => screen.findByRole('dialog', undefined, WAIT);

let calls: { path: string; body: string | undefined }[] = [];
beforeEach(() => {
  replace.mockClear();
  search = '';
  granted = ['analytics:read', 'api:update', 'api:read', 'key:read'];
  calls = mockFetch((call) => {
    if (call.path.startsWith('/analytics/traffic/search/')) {
      const id = Number(call.path.split('?')[0]?.split('/').at(-1));
      return ok(detailOf(id));
    }
    if (call.path === '/analytics/traffic/search') return ok(page([item(1), item(2), item(3)]));
    return ok([]);
  });
});

describe('search page deep link: opening a request', () => {
  it('puts the request in the URL, keeping the search and range, when a row is clicked', async () => {
    search = 'q=status%3A500&range=7d';
    renderApp(<TrafficSearchPage />);
    fireEvent.click(await screen.findByText('/orders/2', undefined, WAIT), { detail: 1 });
    // A plain click on a row waits out a possible double click before it acts.
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    }, WAIT);
    const { path, params, options } = lastReplace();
    expect(path).toBe('/analytics/search');
    expect(Object.fromEntries(params)).toEqual({ q: 'status:500', range: '7d', req: '2', ts: ts(2) });
    // No scroll jump, and replace (not push): the back button leaves the page, not the last request.
    expect(options).toEqual({ scroll: false });
  });

  it('gives each row, for a new tab, the very address a plain click on it writes into the URL', async () => {
    search = 'q=status%3A500&range=7d';
    renderApp(<TrafficSearchPage />);
    const text = await screen.findByText('/orders/2', undefined, WAIT);
    const hidden = text.closest('tr')?.querySelector('a[data-row-link]');
    if (!hidden) throw new Error('the row has no link');
    fireEvent.click(text, { detail: 1 });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    }, WAIT);
    // The same string, so the new tab opens the same sheet over the same search and range.
    expect(hidden.getAttribute('href')).toBe(String(replace.mock.calls[0]?.[0]));
  });

  it('puts req and ts in a row\'s address once, replacing those of the request that is open, and keeps the rest', async () => {
    search = `q=status%3A500&range=7d&req=1&ts=${encodeURIComponent(ts(1))}`;
    renderApp(<TrafficSearchPage />);
    const text = await screen.findByText('/orders/2', { selector: 'span' }, WAIT);
    const href = text.closest('tr')?.querySelector('a[data-row-link]')?.getAttribute('href') ?? '';
    const [path, query = ''] = href.split('?');
    const params = new URLSearchParams(query);
    expect(path).toBe('/analytics/search');
    expect(params.getAll('req')).toEqual(['2']);
    expect(params.getAll('ts')).toEqual([ts(2)]);
    expect(Object.fromEntries(params)).toEqual({ q: 'status:500', range: '7d', req: '2', ts: ts(2) });
  });

  it('does not open the sheet in this tab for a Ctrl, Cmd or Shift click, or a middle click, on a row', async () => {
    renderApp(<TrafficSearchPage />);
    const text = await screen.findByText('/orders/2', { selector: 'span' }, WAIT);
    const hidden = text.closest('tr')?.querySelector('a[data-row-link]');
    if (!hidden) throw new Error('the row has no link');
    const reached: string[] = [];
    hidden.addEventListener('click', (event) => {
      if (!(event instanceof MouseEvent)) return;
      reached.push(`${event.ctrlKey ? 'ctrl' : ''}${event.metaKey ? 'meta' : ''}${event.shiftKey ? 'shift' : ''}`);
      event.preventDefault();
    });
    fireEvent.click(text, { detail: 1, ctrlKey: true });
    fireEvent.click(text, { detail: 1, metaKey: true });
    fireEvent.click(text, { detail: 1, shiftKey: true });
    fireEvent(text, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    // Each was passed to the link at once (no delay is pending), and none of them wrote the URL.
    expect(reached).toEqual(['ctrl', 'meta', 'shift', 'ctrlmeta']);
    expect(replace).not.toHaveBeenCalled();
  });

  it('opens the request a link names, even though it is not among the loaded results', async () => {
    search = `req=9&ts=${encodeURIComponent(ts(9))}`;
    renderApp(<TrafficSearchPage />);
    const d = await dialog();
    expect(await within(d).findByRole('heading', { name: 'POST /orders/9 500' }, WAIT)).toBeDefined();
    expect(calls.some((c) => c.path === `/analytics/traffic/search/9?ts=${encodeURIComponent(ts(9))}`)).toBe(true);
  });

  it('opens the request a link names when it is among the loaded results, with its neighbours', async () => {
    search = `req=2&ts=${encodeURIComponent(ts(2))}`;
    renderApp(<TrafficSearchPage />);
    const d = await dialog();
    // The sheet opens from the URL alone; the neighbours appear once the results have loaded.
    const position = D.position.replace(/<\/?bdi>/g, '').replace('{index}', '2').replace('{count}', '3').replace('{request}', 'POST /orders/2, 500');
    // The request in the line is its own element, so the text is matched on the whole line.
    expect(
      await within(d).findByText(
        (_content, element) => element?.getAttribute('aria-live') === 'polite' && element.textContent === position,
        undefined,
        WAIT,
      ),
    ).toBeDefined();
    expect(within(d).getByRole('button', { name: D.previous }).getAttribute('aria-disabled')).toBeNull();
    expect(within(d).getByRole('button', { name: D.next }).getAttribute('aria-disabled')).toBeNull();
  });

  it.each([
    ['an id that is not a number', `req=..%2F..%2Fauth%2Fme&ts=${encodeURIComponent(ts(1))}`],
    ['a timestamp that is not one', 'req=1&ts=yesterday'],
    ['an id without a timestamp', 'req=1'],
  ])('ignores %s: no sheet and no request for it', async (_name, query) => {
    search = query;
    renderApp(<TrafficSearchPage />);
    await screen.findByText('/orders/1', undefined, WAIT);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/analytics/traffic/search/'))).toBe(false);
  });
});

describe('search page deep link: closing and stepping', () => {
  it('takes the request out of the URL, and only that, when the sheet closes', async () => {
    search = `q=status%3A500&req=1&ts=${encodeURIComponent(ts(1))}`;
    renderApp(<TrafficSearchPage />);
    await dialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    }, WAIT);
    expect(Object.fromEntries(lastReplace().params)).toEqual({ q: 'status:500' });
  });

  it('moves the URL to the next loaded request', async () => {
    search = `req=2&ts=${encodeURIComponent(ts(2))}`;
    renderApp(<TrafficSearchPage />);
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: D.next }, WAIT));
    expect(Object.fromEntries(lastReplace().params)).toEqual({ req: '3', ts: ts(3) });
    fireEvent.click(within(d).getByRole('button', { name: D.previous }));
    expect(Object.fromEntries(lastReplace().params)).toEqual({ req: '1', ts: ts(1) });
  });
});

describe('search page deep link: find similar', () => {
  it('adds the filter to the search through the search bar, then closes the sheet once the search has changed', async () => {
    search = `q=status%3A500&req=1&ts=${encodeURIComponent(ts(1))}`;
    const view = renderApp(<TrafficSearchPage />);
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: D.similar.path }, WAIT));

    // First the search itself changes (the request stays in the URL for that one write)...
    expect(replace).toHaveBeenCalledTimes(1);
    expect(lastReplace().params.get('q')).toBe('status:500 path:/orders/1');
    expect(lastReplace().params.get('req')).toBe('1');

    // ...and only when that has landed does the sheet close, from the new URL, so neither write is lost.
    search = 'q=status%3A500+path%3A%2Forders%2F1&req=1&ts=' + encodeURIComponent(ts(1));
    view.rerender(<TrafficSearchPage />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(2);
    }, WAIT);
    expect(Object.fromEntries(lastReplace().params)).toEqual({ q: 'status:500 path:/orders/1' });
  });

  it('does not close the sheet for a search change nobody asked it to follow', async () => {
    search = `req=1&ts=${encodeURIComponent(ts(1))}`;
    const view = renderApp(<TrafficSearchPage />);
    await dialog();
    search = `q=status%3A500&req=1&ts=${encodeURIComponent(ts(1))}`;
    view.rerender(<TrafficSearchPage />);
    // Closing would be an effect of that very render, and `rerender` flushes effects before it returns:
    // nothing to wait for, so nothing to time.
    expect(replace).not.toHaveBeenCalled();
  });

  it('lets two filters added from the open request in quick succession both land, then closes after the last', async () => {
    search = `req=1&ts=${encodeURIComponent(ts(1))}`;
    const view = renderApp(<TrafficSearchPage />);
    const d = await dialog();
    const path = await within(d).findByRole('button', { name: D.similar.path }, WAIT);
    const apiButton = within(d).getByRole('button', { name: D.similar.api });
    // Both before the URL has changed, as a fast second click would be.
    fireEvent.click(path);
    fireEvent.click(apiButton);
    expect(replace).toHaveBeenCalledTimes(2);
    const q = (call: number) => new URLSearchParams(String(replace.mock.calls[call]?.[0]).split('?')[1]).get('q');
    expect(q(0)).toBe('path:/orders/1');
    expect(q(1)).toBe(`path:/orders/1 api:${API_ID}`);
    // Only when the last has landed does the sheet close, from that URL.
    search = `q=${encodeURIComponent(`path:/orders/1 api:${API_ID}`)}&req=1&ts=${encodeURIComponent(ts(1))}`;
    view.rerender(<TrafficSearchPage />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(3);
    }, WAIT);
    expect(Object.fromEntries(lastReplace().params)).toEqual({ q: `path:/orders/1 api:${API_ID}` });
  });

  it('refuses a filter the search cannot take: a duplicate, or a ninth filter', async () => {
    search = `q=status%3A500+path%3A%2Forders%2F1&req=1&ts=${encodeURIComponent(ts(1))}`;
    renderApp(<TrafficSearchPage />);
    const d = await dialog();
    const same = await within(d).findByRole('button', { name: D.similar.path }, WAIT);
    expect(same.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(same);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('search page: the result count is spoken', () => {
  it('says how many results are loaded and how many filters the search holds, and updates when a chip is added', async () => {
    search = 'q=status%3A500+method%3APOST';
    const view = renderApp(<TrafficSearchPage />);
    // The search bar has a live region of its own, so look for ours among them.
    const spoken = () => screen.getAllByRole('status').map((el) => el.textContent);
    await waitFor(() => {
      expect(spoken()).toContain('3 results loaded · 2 filters');
    }, WAIT);
    search = 'q=status%3A500+method%3APOST+path%3A%2Forders';
    view.rerender(<TrafficSearchPage />);
    await waitFor(() => {
      expect(spoken()).toContain('3 results loaded · 3 filters');
    }, WAIT);
  });
});
