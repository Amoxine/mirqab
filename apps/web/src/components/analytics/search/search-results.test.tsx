// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { ROW_CLICK_DELAY_MS } from '@open-gateway/ui';
import { createTranslator } from 'next-intl';
import { indexedAgo, renderApp } from '@/components/dashboard/test-render';
import ar from '@/messages/ar/analytics.json';
import en from '@/messages/en/analytics.json';
import fr from '@/messages/fr/analytics.json';
import { createFormat } from '@/hooks/use-format';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { ApiRequestError } from '@/lib/api-client';
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
      indexedUntil={indexedAgo(10_000)}
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
    indexedUntil: indexedAgo(10_000),
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
    indexedUntil: indexedAgo(10_000),
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
    update({ items: [item(1), item(2)], indexedUntil: indexedAgo(5_000) });
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

describe('SearchResults: a search index that is behind must look behind', () => {
  type Props = Parameters<typeof SearchResults>[0];
  const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();
  const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();
  const SECOND = 1_000;
  const MINUTE = 60 * SECOND;
  const base: Props = {
    items: [item(1), item(2)],
    isLoading: false,
    isRefetching: false,
    error: null,
    hasMore: false,
    isFetchingMore: false,
    hasFilters: false,
    filterCount: 0,
    indexedUntil: null,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    getHref: hrefOf,
  };
  const view = (over: Partial<Props>) => {
    const ui = (o: Partial<Props>) => <SearchResults {...base} {...o} />;
    const rendered = renderApp(ui(over));
    return { update: (o: Partial<Props>) => { rendered.rerender(ui(o)); } };
  };
  const BEHIND = en.search.indexBehindTitle;

  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows plain muted freshness, and no warning, while the index is within two minutes of now', () => {
    view({ indexedUntil: at(30 * SECOND) });
    expect(screen.getByText(/Indexed up to/)).toBeDefined();
    expect(screen.queryByText(BEHIND)).toBeNull();
  });

  it.each([
    ['one second inside the limit', 119 * SECOND, false],
    ['at the limit', 120 * SECOND, false],
    ['one second past it', 121 * SECOND, true],
    ['three minutes', 3 * MINUTE, true],
    ['four days', 4 * 24 * 60 * MINUTE, true],
  ])('with the index %s behind', (_name, age, warned) => {
    view({ indexedUntil: at(age) });
    expect(screen.queryByText(BEHIND) !== null).toBe(warned);
  });

  it('warns in the warning tone, with the age, and says it once instead of repeating the muted line', () => {
    view({ indexedUntil: at(3 * MINUTE) });
    const warning = screen.getByText(BEHIND).closest('[role="note"]');
    if (!warning) throw new Error('the warning is not a note');
    expect(warning.className).toContain('border-warning');
    expect(within(warning as HTMLElement).getByText('Indexed up to 3 minutes ago')).toBeDefined();
    expect(screen.getAllByText(/Indexed up to/)).toHaveLength(1);
  });

  it('is not a live region of its own: its age text changes, and a refetch must not read it out again', () => {
    view({ indexedUntil: at(3 * MINUTE) });
    const warning = screen.getByText(BEHIND).closest('[role]');
    expect(warning?.getAttribute('role')).toBe('note');
    expect(screen.getByText(BEHIND).closest('[aria-live]')).toBeNull();
  });

  it('is said once through the result count when the index falls behind, and not again as the age moves', () => {
    const { update } = view({ indexedUntil: at(10 * SECOND), filterCount: 1 });
    expect(screen.getByRole('status').textContent).toBe('2 results loaded · 1 filter');
    update({ indexedUntil: at(3 * MINUTE), filterCount: 1 });
    expect(screen.getByRole('status').textContent).toBe(`2 results loaded · 1 filter · ${en.search.indexBehindShort}`);
    const observer = new MutationObserver(() => undefined);
    observer.observe(screen.getByRole('status'), { subtree: true, childList: true, characterData: true, attributes: true });
    update({ indexedUntil: at(5 * MINUTE), filterCount: 1 });
    expect(observer.takeRecords()).toHaveLength(0);
  });

  describe('an empty result', () => {
    const wrongAdvice = [en.search.emptyNoCapture, en.search.emptyNoMatch];

    it('is explained by the index being behind, not by advice that would send the user the wrong way', () => {
      view({ items: [], indexedUntil: at(4 * 24 * 60 * MINUTE), hasFilters: true, filterCount: 1 });
      expect(screen.getByText(en.search.emptyIndexBehind)).toBeDefined();
      for (const advice of wrongAdvice) expect(screen.queryByText(advice)).toBeNull();
      expect(screen.queryByText(/detailed recording/)).toBeNull();
    });

    it('does the same with no filters, where the old copy told the user to turn recording on', () => {
      view({ items: [], indexedUntil: at(4 * 24 * 60 * MINUTE), hasFilters: false });
      expect(screen.getByText(en.search.emptyIndexBehind)).toBeDefined();
      expect(screen.queryByText(en.search.emptyNoCapture)).toBeNull();
    });

    it('keeps its own advice while the index is current', () => {
      view({ items: [], indexedUntil: at(10 * SECOND), hasFilters: true });
      expect(screen.getByText(en.search.emptyNoMatch)).toBeDefined();
      expect(screen.queryByText(en.search.emptyIndexBehind)).toBeNull();
    });

    it('still says the index has not started when it has never reported', () => {
      view({ items: [], indexedUntil: null });
      expect(screen.getAllByText(en.search.notIndexedYet).length).toBeGreaterThan(0);
      expect(screen.queryByText(BEHIND)).toBeNull();
    });

    it('does not claim an empty result is certain: it speaks of what is indexed', () => {
      for (const locale of [en, fr, ar]) {
        expect(locale.search.emptyNoMatch).not.toMatch(/^(No captured request matches these filters in this window\.|Aucune requête capturée ne correspond à ces filtres sur cette période\.)$/);
      }
      expect(en.search.emptyNoMatch).toContain('indexed');
    });
  });

  it.each([['en', en], ['fr', fr], ['ar', ar]] as const)('has its warning and empty explanation in %s, with nothing left unfilled', (locale, messages) => {
    const t = createTranslator({ locale, messages: { analytics: messages }, namespace: 'analytics.search' });
    for (const key of ['indexBehindTitle', 'indexBehindShort', 'emptyIndexBehind', 'loadMoreFailed', 'rangeUnknown'] as const) {
      expect(t(key).length, key).toBeGreaterThan(0);
      expect(t(key)).not.toMatch(/[{}]/);
    }
  });
});

describe('SearchResults: an index that covers only part of the window must not read as complete', () => {
  type Props = Parameters<typeof SearchResults>[0];
  const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();
  const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();
  const DAY = 24 * 60 * 60 * 1_000;
  const base: Props = {
    items: [item(1), item(2)],
    isLoading: false,
    isRefetching: false,
    error: null,
    hasMore: false,
    isFetchingMore: false,
    hasFilters: false,
    filterCount: 0,
    indexedUntil: at(10_000),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    getHref: hrefOf,
  };
  const view = (over: Partial<Props>) => renderApp(<SearchResults {...base} {...over} />);
  const TITLE = en.search.coveragePartialTitle;

  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([['complete'], [undefined]] as const)('shows nothing extra when coverage is %s (an older API sends none)', (coverage) => {
    view({ coverage, indexedFrom: at(30 * DAY) });
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it('says where coverage starts, in the UI locale format, as a note and not a live region', () => {
    const from = at(2 * DAY);
    view({ coverage: 'partial', indexedFrom: from });
    const note = screen.getByText(TITLE).closest('[role="note"]');
    if (!note) throw new Error('the partial-coverage message is not a note');
    expect(within(note as HTMLElement).getByText(`Requests are searchable from ${createFormat('en').dateTime(from)} on.`)).toBeDefined();
    expect(screen.getByText(TITLE).closest('[aria-live]')).toBeNull();
  });

  it('says it without a start when the API cannot name one', () => {
    view({ coverage: 'partial', indexedFrom: null });
    expect(screen.getByText(TITLE)).toBeDefined();
    expect(screen.queryByText(/Requests are searchable from/)).toBeNull();
  });

  it('explains an empty result by the partial coverage, not by advice that assumes everything is indexed', () => {
    view({ items: [], coverage: 'partial', indexedFrom: at(2 * DAY), hasFilters: true, filterCount: 1 });
    expect(screen.getByText(en.search.emptyPartial)).toBeDefined();
    expect(screen.queryByText(en.search.emptyNoMatch)).toBeNull();
    expect(screen.queryByText(en.search.emptyNoCapture)).toBeNull();
  });

  it('leaves the behind warning to say it alone when the index is also late', () => {
    view({ items: [], coverage: 'partial', indexedFrom: at(2 * DAY), indexedUntil: at(10 * 60_000) });
    expect(screen.getByText(en.search.indexBehindTitle)).toBeDefined();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.getByText(en.search.emptyIndexBehind)).toBeDefined();
  });

  it('keeps the plain empty advice when coverage is complete', () => {
    view({ items: [], coverage: 'complete', indexedFrom: at(30 * DAY), hasFilters: true, filterCount: 1 });
    expect(screen.getByText(en.search.emptyNoMatch)).toBeDefined();
    expect(screen.queryByText(en.search.emptyPartial)).toBeNull();
  });

  it.each([['en', en], ['fr', fr], ['ar', ar]] as const)('has its three messages in %s, with only the date left to fill', (locale, messages) => {
    const t = createTranslator({ locale, messages: { analytics: messages }, namespace: 'analytics.search' });
    expect(t('coveragePartialTitle').length).toBeGreaterThan(0);
    expect(t('emptyPartial').length).toBeGreaterThan(0);
    expect(t('coveragePartialSince', { when: '1 Oct' })).toContain('1 Oct');
    expect(t('coveragePartialTitle')).not.toMatch(/[{}]/);
    expect(t('emptyPartial')).not.toMatch(/[{}]/);
  });
});

describe('SearchResults: a page that fails to load keeps the rows already loaded', () => {
  type Props = Parameters<typeof SearchResults>[0];
  const base: Props = {
    items: [item(1), item(2)],
    isLoading: false,
    isRefetching: false,
    error: null,
    hasMore: true,
    isFetchingMore: false,
    hasFilters: false,
    filterCount: 0,
    indexedUntil: indexedAgo(10_000),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    getHref: hrefOf,
  };
  beforeEach(() => {
    granted = ['analytics:read', 'api:update', 'api:read'];
  });

  it.each([
    ['429 SEARCH_BUSY', new ApiRequestError('busy', 429, 'SEARCH_BUSY'), en.search.apiErrors.busy],
    ['422 SEARCH_TOO_BROAD', new ApiRequestError('broad', 422, 'SEARCH_TOO_BROAD'), en.search.apiErrors.tooBroad],
    ['500', new ApiRequestError('boom', 500), en.search.apiErrors.generic],
  ])('keeps the rows and says so next to Load more when the next page fails with %s', (_name, error, reason) => {
    renderApp(<SearchResults {...base} loadMoreError={error} />);
    expect(screen.getByText('/orders/1')).toBeDefined();
    expect(screen.getByText('/orders/2')).toBeDefined();
    expect(screen.getByText(en.search.loadMoreFailed)).toBeDefined();
    expect(screen.getByText(reason)).toBeDefined();
    // Not the full-page error: no "Something went wrong" view replaced the list.
    expect(screen.queryByText(en.errorState.title)).toBeNull();
  });

  it('retries the NEXT page only: its button is the load-more action, not a refetch of every loaded page', () => {
    const onLoadMore = vi.fn();
    const onRetry = vi.fn();
    renderApp(<SearchResults {...base} loadMoreError={new ApiRequestError('busy', 429, 'SEARCH_BUSY')} onLoadMore={onLoadMore} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: en.search.loadMore })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('announces the failure as an alert, since it appears on its own', () => {
    renderApp(<SearchResults {...base} loadMoreError={new ApiRequestError('busy', 429, 'SEARCH_BUSY')} />);
    expect(screen.getByRole('alert').textContent).toContain(en.search.loadMoreFailed);
  });

  it('shows the normal Load more button when nothing failed', () => {
    renderApp(<SearchResults {...base} />);
    expect(screen.getByRole('button', { name: en.search.loadMore })).toBeDefined();
    expect(screen.queryByText(en.search.loadMoreFailed)).toBeNull();
  });

  it('still replaces everything with the full error view when the FIRST page failed (no rows to keep)', () => {
    const onRetry = vi.fn();
    renderApp(<SearchResults {...base} items={[]} error={new ApiRequestError('busy', 429, 'SEARCH_BUSY')} onRetry={onRetry} />);
    expect(screen.getByText(en.search.apiErrors.busy)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
