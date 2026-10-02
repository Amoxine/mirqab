// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { ROW_CLICK_DELAY_MS } from '@open-gateway/ui';
import { createTranslator } from 'next-intl';
import { renderApp } from '@/components/dashboard/test-render';
import ar from '@/messages/ar/analytics.json';
import en from '@/messages/en/analytics.json';
import fr from '@/messages/fr/analytics.json';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { SearchResults } from './search-results';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

/** The page's address with a result open, as the page builds it (`useOpenRequest.hrefTo`). */
const hrefOf = (i: TrafficSearchItem) => `/analytics/search?req=${i.id}&ts=${encodeURIComponent(i.ts)}`;
const item = (n: number, over: Partial<TrafficSearchItem> = {}): TrafficSearchItem => ({
  id: String(n),
  ts: `2026-09-29T10:00:0${String(n)}.123456Z`,
  apiId: 'def-1',
  apiName: 'Orders API',
  method: 'POST',
  path: `/orders/${String(n)}`,
  status: 500,
  latencyMs: 340,
  keyAlias: 'qbus-web',
  reqTruncated: false,
  resTruncated: false,
  ...over,
});

function renderResults(items: TrafficSearchItem[], onOpen = vi.fn()) {
  renderApp(
    <SearchResults
      items={items}
      isLoading={false}
      isRefetching={false}
      error={null}
      hasMore={false}
      isFetchingMore={false}
      hasFilters={false}
      filterCount={0}
      indexedUntil="2026-09-29T11:59:50.000Z"
      onLoadMore={vi.fn()}
      onRetry={vi.fn()}
      onOpen={onOpen}
      getHref={hrefOf}
    />,
  );
  return onOpen;
}
const rowOf = (path: string) => screen.getByText(path).closest('tr') as HTMLElement;

describe('SearchResults rows', () => {
  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
    vi.useFakeTimers();
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });
  const settle = () => {
    act(() => {
      vi.advanceTimersByTime(ROW_CLICK_DELAY_MS + 10);
    });
  };

  it('opens a result from anywhere in its row, not only from the time', () => {
    const onOpen = renderResults([item(1), item(2)]);
    fireEvent.click(screen.getByText('/orders/2'), { detail: 1 });
    settle();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
    fireEvent.click(within(rowOf('/orders/1')).getByText('340 ms', { exact: false }), { detail: 1 });
    settle();
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: '1' }));
    // The empty padding of a cell counts as the row too.
    fireEvent.click(rowOf('/orders/1').querySelectorAll('td')[5] as HTMLElement, { detail: 1 });
    settle();
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('waits out a possible second click before opening, and not longer', () => {
    const onOpen = renderResults([item(1)]);
    fireEvent.click(screen.getByText('/orders/1'), { detail: 1 });
    act(() => {
      vi.advanceTimersByTime(ROW_CLICK_DELAY_MS - 1);
    });
    expect(onOpen).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open a result on a double click (selecting a word of the path) or a triple click (the whole line)', () => {
    const onOpen = renderResults([item(1)]);
    const path = screen.getByText('/orders/1');
    fireEvent.click(path, { detail: 1 });
    fireEvent.click(path, { detail: 2 });
    settle();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(path, { detail: 1 });
    fireEvent.click(path, { detail: 2 });
    fireEvent.click(path, { detail: 3 });
    settle();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens a result exactly once when its time button is used (the row does not open it a second time)', () => {
    const onOpen = renderResults([item(1)]);
    fireEvent.click(screen.getByRole('button', { name: /Open POST \/orders\/1/ }), { detail: 1 });
    expect(onOpen).toHaveBeenCalledTimes(1);
    settle();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the time button as the keyboard way in: a real, focusable button named by its visible text first', () => {
    renderResults([item(1)]);
    const button = screen.getByRole('button', { name: /Open POST \/orders\/1/ });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    // No aria-label that replaces the date: the name is the visible time, then what the button does.
    expect(button.hasAttribute('aria-label')).toBe(false);
    const visible = button.querySelector('time')?.textContent ?? '';
    expect(visible).toContain('Sep 29, 2026');
    expect(button.textContent.startsWith(visible)).toBe(true);
    expect(button.querySelector('.sr-only')?.textContent).toBe('Open POST /orders/1');
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('marks the time button as where focus returns to when the sheet for that result closes', () => {
    renderResults([item(1), item(2)]);
    const buttons = screen.getAllByRole('button', { name: /Open POST/ });
    expect(buttons.map((b) => b.getAttribute('data-focus-return'))).toEqual([
      'search:1@2026-09-29T10:00:01.123456Z',
      'search:2@2026-09-29T10:00:02.123456Z',
    ]);
  });

  it('leaves the API name as a link to the API, which does not open the result', () => {
    const onOpen = renderResults([item(1)]);
    const link = within(rowOf('/orders/1')).getByRole('link', { name: 'Orders API' });
    expect(link.getAttribute('href')).toBe('/apis/def-1');
    // The click still reaches the link, and the row ignores it.
    fireEvent.click(link, { detail: 1 });
    settle();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows the API name as plain text, not a link to a page the user may not open, without api:read', () => {
    granted = ['analytics:read', 'api:update'];
    renderResults([item(1)]);
    const row = rowOf('/orders/1');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('Orders API')).toBeDefined();
  });

  it('does not open a result when the click ends a text selection, such as copying a path', () => {
    const onOpen = renderResults([item(1)]);
    const path = screen.getByText('/orders/1');
    window.getSelection()?.selectAllChildren(path);
    expect(window.getSelection()?.toString()).toBe('/orders/1');
    fireEvent.click(path, { detail: 1 });
    settle();
    expect(onOpen).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    fireEvent.click(path, { detail: 1 });
    settle();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the row as clickable', () => {
    renderResults([item(1)]);
    expect(rowOf('/orders/1').className).toContain('cursor-pointer');
  });
});

describe('SearchResults rows as links (a new tab for a modified or middle click)', () => {
  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
    vi.useFakeTimers();
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });
  const settle = () => {
    act(() => {
      vi.advanceTimersByTime(ROW_CLICK_DELAY_MS + 10);
    });
  };
  /** What reaches a row's hidden link, with its modifiers; the default is cancelled so jsdom does not navigate. */
  function watchLink(path: string) {
    const link = rowOf(path).querySelector<HTMLAnchorElement>('a[data-row-link]');
    if (!link) throw new Error('no row link');
    const seen: { ctrl: boolean; meta: boolean; shift: boolean }[] = [];
    link.addEventListener('click', (event) => {
      seen.push({ ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey });
      event.preventDefault();
    });
    return seen;
  }

  it("gives every row one hidden link, to that result's address", () => {
    renderResults([item(1), item(2)]);
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([hrefOf(item(1)), hrefOf(item(2))]);
    // Hidden, out of the tab order and unannounced: the time button is the keyboard's way in.
    expect(links.every((a) => a.hidden && a.getAttribute('aria-hidden') === 'true' && a.tabIndex === -1)).toBe(true);
    expect(within(rowOf('/orders/1')).queryAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/apis/def-1']);
  });

  it.each([['ctrlKey'], ['metaKey'], ['shiftKey']])(
    'a %s click on the row sends the link a click with that modifier, and does not open the sheet in this tab',
    (modifier) => {
      const onOpen = renderResults([item(1)]);
      const seen = watchLink('/orders/1');
      fireEvent.click(screen.getByText('/orders/1'), { detail: 1, [modifier]: true });
      settle();
      expect(seen).toEqual([{ ctrl: modifier === 'ctrlKey', meta: modifier === 'metaKey', shift: modifier === 'shiftKey' }]);
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it.each([['ctrlKey'], ['metaKey'], ['shiftKey']])(
    'a %s click on the time button does the same: the new tab, not the sheet',
    (modifier) => {
      const onOpen = renderResults([item(1)]);
      const seen = watchLink('/orders/1');
      fireEvent.click(screen.getByRole('button', { name: /Open POST \/orders\/1/ }), { detail: 1, [modifier]: true });
      settle();
      expect(seen).toEqual([{ ctrl: modifier === 'ctrlKey', meta: modifier === 'metaKey', shift: modifier === 'shiftKey' }]);
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it.each([['the row'], ['the time button']])('a middle click on %s opens a new tab and not the sheet', (where) => {
    const onOpen = renderResults([item(1)]);
    const seen = watchLink('/orders/1');
    const target = where === 'the row' ? screen.getByText('/orders/1') : screen.getByRole('button', { name: /Open POST/ });
    fireEvent(target, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    settle();
    // Both modifiers, because the one that means "new tab" is Ctrl on most systems and Cmd on a Mac.
    expect(seen).toEqual([{ ctrl: true, meta: true, shift: false }]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a plain click still opens the sheet in place and does not follow the link', () => {
    const onOpen = renderResults([item(1)]);
    const seen = watchLink('/orders/1');
    fireEvent.click(screen.getByText('/orders/1'), { detail: 1 });
    settle();
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Open POST/ }), { detail: 1 });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([]);
  });

  it('keeps a double click selecting the path, with no sheet and no new tab', () => {
    const onOpen = renderResults([item(1)]);
    const seen = watchLink('/orders/1');
    const path = screen.getByText('/orders/1');
    fireEvent.click(path, { detail: 1 });
    fireEvent.click(path, { detail: 2 });
    settle();
    expect(onOpen).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe('SearchResults "Load more"', () => {
  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
  });

  type Props = Parameters<typeof SearchResults>[0];
  const props = (over: Partial<Props>): Props => ({
    items: [item(1), item(2)],
    isLoading: false,
    isRefetching: false,
    error: null,
    hasMore: true,
    isFetchingMore: false,
    hasFilters: false,
    filterCount: 0,
    indexedUntil: '2026-09-29T11:59:50.000Z',
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    getHref: hrefOf,
    ...over,
  });

  it('moves focus to the first new row, so a keyboard user continues where the new results begin', () => {
    const onLoadMore = vi.fn();
    const view = renderApp(<SearchResults {...props({ onLoadMore })} />);
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    fireEvent.click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    view.rerender(<SearchResults {...props({ onLoadMore, isFetchingMore: true })} />);
    view.rerender(<SearchResults {...props({ onLoadMore, items: [item(1), item(2), item(3), item(4)] })} />);
    expect(document.activeElement?.getAttribute('data-focus-return')).toBe('search:3@2026-09-29T10:00:03.123456Z');
  });

  it('leaves focus alone when the next page fails to load, and when results change for another reason', () => {
    const view = renderApp(<SearchResults {...props({})} />);
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    fireEvent.click(more);
    view.rerender(<SearchResults {...props({ isFetchingMore: true })} />);
    view.rerender(<SearchResults {...props({})} />);
    // The load ended without new rows; a later, unrelated growth must not steal focus.
    more.focus();
    view.rerender(<SearchResults {...props({ items: [item(1), item(2), item(3)] })} />);
    expect(document.activeElement).toBe(more);
  });
});

describe('SearchResults result count (the live region)', () => {
  type Props = Parameters<typeof SearchResults>[0];
  const base: Props = {
    items: [item(1), item(2)],
    isLoading: false,
    isRefetching: false,
    error: null,
    hasMore: false,
    isFetchingMore: false,
    hasFilters: true,
    filterCount: 2,
    indexedUntil: '2026-09-29T11:59:50.000Z',
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    getHref: hrefOf,
  };
  function view(over: Partial<Props> = {}) {
    const ui = (o: Partial<Props>) => <SearchResults {...base} {...o} />;
    const rendered = renderApp(ui(over));
    return { update: (o: Partial<Props>) => { rendered.rerender(ui(o)); } };
  }
  const status = () => screen.getByRole('status');
  /** Counts what the page does to the live region from now on: an unchanged one is never touched, so is never re-announced. */
  function watchStatus() {
    const observer = new MutationObserver(() => undefined);
    observer.observe(status(), { subtree: true, childList: true, characterData: true, attributes: true });
    return { changes: () => observer.takeRecords().length };
  }

  it('says how many results are loaded and how many filters apply', () => {
    view();
    expect(status().textContent).toBe('2 results loaded · 2 filters');
  });

  it.each([
    ['one result and one filter', [item(1)], 1, '1 result loaded · 1 filter'],
    ['nothing found', [], 0, 'No results · no filters'],
    ['nothing found with filters', [], 3, 'No results · 3 filters'],
  ])('reads %s', (_name, items, filterCount, expected) => {
    view({ items, filterCount });
    expect(status().textContent).toBe(expected);
  });

  it('does not put the index freshness in the live region, so a refetch that moves it says nothing', () => {
    view();
    expect(status().textContent).not.toContain('Indexed up to');
    // It is still on the page, as plain text.
    expect(screen.getByText(/Indexed up to/)).toBeDefined();
  });

  it('says nothing while the first page loads, and the count once it has', () => {
    const { update } = view({ isLoading: true });
    expect(screen.queryByRole('status')).toBeNull();
    update({ isLoading: false });
    expect(status().textContent).toBe('2 results loaded · 2 filters');
  });

  it('stays quiet while a changed search loads (the stale results are still shown), then says the new count', () => {
    const { update } = view();
    const watch = watchStatus();
    update({ isRefetching: true, filterCount: 3, items: [item(1), item(2)] });
    expect(status().textContent).toBe('2 results loaded · 2 filters');
    expect(watch.changes()).toBe(0);
    update({ isRefetching: false, filterCount: 3, items: [item(1)] });
    expect(status().textContent).toBe('1 result loaded · 3 filters');
  });

  it('says so when a filter is added or removed even though the count stays the same', () => {
    const { update } = view();
    const watch = watchStatus();
    update({ filterCount: 3 });
    expect(status().textContent).toBe('2 results loaded · 3 filters');
    expect(watch.changes()).toBeGreaterThan(0);
  });

  it('says nothing when the same results come back (a background refetch)', () => {
    const { update } = view();
    const watch = watchStatus();
    update({ items: [item(1), item(2)], indexedUntil: '2026-09-29T11:59:59.000Z' });
    expect(watch.changes()).toBe(0);
  });

  it('keeps the last settled count when the refetch fails, rather than announcing a wrong one', () => {
    const { update } = view();
    update({ error: new Error('boom') });
    // The error view replaces the list; the region is gone with it and nothing was announced for it.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the result count message, in every language', () => {
  const MESSAGES = { en, fr, ar };
  // 0, 1, 2 and 3-10, 11-99 and 100 hit Arabic's zero / one / two / few / many / other forms.
  const COUNTS = [0, 1, 2, 3, 10, 11, 99, 100, 101, 1_000_000];

  it.each(['en', 'fr', 'ar'] as const)('formats for every count and filter count in %s, with nothing left unfilled', (locale) => {
    const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'search' });
    for (const count of COUNTS) {
      for (const filters of COUNTS) {
        const text = t('resultCount', { count, filters });
        expect(text).not.toMatch(/[{}#]/);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('SearchResults layout guards', () => {
  const LONG_API = 'OrdersGatewayApiV'.repeat(7).slice(0, 100);
  const KEY = 'web-dashboard-v2-production-key';

  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
  });

  it('caps a long unbroken API name, cut with an ellipsis and whole in its tooltip, so it cannot stretch the table past its scroller', () => {
    renderResults([item(1, { apiName: LONG_API })]);
    const link = screen.getByText(LONG_API);
    expect(link.getAttribute('title')).toBe(LONG_API);
    expect(link.className).toContain('truncate');
    expect(link.closest('td')?.className).toContain('max-w-[16rem]');
  });

  it('does the same for an API name that is not a link', () => {
    granted = ['analytics:read', 'api:update'];
    renderResults([item(1, { apiName: LONG_API })]);
    const name = screen.getByText(LONG_API);
    expect(name.tagName).toBe('SPAN');
    expect(name.getAttribute('title')).toBe(LONG_API);
    expect(name.className).toContain('truncate');
  });

  it('keeps the latency on one line', () => {
    renderResults([item(1)]);
    expect(screen.getByText('340 ms', { exact: false }).closest('td')?.className).toContain('whitespace-nowrap');
  });

  it('keeps a key name on one line, cut with an ellipsis and whole in its tooltip', () => {
    renderResults([item(1, { keyAlias: KEY })]);
    const key = screen.getByText(KEY);
    expect(key.getAttribute('title')).toBe(KEY);
    expect(key.className).toContain('truncate');
    expect(key.closest('td')?.className).toContain('max-w-[12rem]');
  });

  it('has no tooltip on the dash shown for a request that has no key', () => {
    renderResults([item(1, { keyAlias: '' })]);
    expect(screen.getByText('—', { selector: 'span.block' }).hasAttribute('title')).toBe(false);
  });
});
