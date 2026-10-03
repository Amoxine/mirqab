// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { DataTable as BaseDataTable, ROW_CLICK_DELAY_MS, type LinkComponent } from '@open-gateway/ui';
import commonMessages from '@/messages/en/common.json';
import dashboardMessages from '@/messages/en/dashboard.json';

const M = dashboardMessages.dataTable;
import { DataTable, ViewModeToggle, useViewMode, type ViewMode } from './data-table';

// RTL's auto-cleanup only runs when vitest has `globals: true` or a setup file calls it; this
// project has neither, so renders from earlier tests otherwise stay in the document and the next
// query matches two elements. Explicit teardown here rather than changing the shared config
// underneath other suites.
afterEach(cleanup);

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider
    locale="en"
    messages={{ dashboard: dashboardMessages, common: commonMessages }}
  >
    {ui}
  </NextIntlClientProvider>
);

interface Row {
  name: string;
  status: string;
}
const COLUMNS: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'status', header: 'Status' },
  { id: 'actions', cell: () => <button type="button">{'row menu'}</button> },
];

function Harness({ rows, emptyAction }: { rows: Row[]; emptyAction?: React.ReactNode }) {
  const table = useReactTable({ data: rows, columns: COLUMNS, getCoreRowModel: getCoreRowModel() });
  return (
    <DataTable
      table={table}
      isLoading={false}
      isError={false}
      emptyMessage="Nothing here"
      emptyAction={emptyAction}
    />
  );
}

/** Stubs `matchMedia` so the `sm` breakpoint query reports `narrow`. */
function stubViewport(narrow: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe('DataTable responsive layout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a real table on wide screens', () => {
    stubViewport(false);
    render(wrap(<Harness rows={[{ name: 'orders', status: 'ACTIVE' }]} />));
    expect(screen.queryByRole('table')).not.toBeNull();
  });

  it('renders label/value cards instead of a table below sm, labelled by the column headers', () => {
    stubViewport(true);
    render(wrap(<Harness rows={[{ name: 'orders', status: 'ACTIVE' }]} />));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('orders')).toBeDefined();
    // The header becomes the value's label, and the header-less actions column still renders.
    expect(screen.getByText('Status').tagName).toBe('DT');
    expect(screen.getByText('ACTIVE').tagName).toBe('DD');
    expect(screen.getByRole('button', { name: 'row menu' })).toBeDefined();
  });

  it('falls back to the table when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(wrap(<Harness rows={[{ name: 'orders', status: 'ACTIVE' }]} />));
    expect(screen.queryByRole('table')).not.toBeNull();
  });

  it("offers the caller's next action in the empty state", () => {
    render(
      wrap(
        <Harness rows={[]} emptyAction={<button type="button">{'Create the first one'}</button>} />,
      ),
    );
    expect(screen.getByText('Nothing here')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create the first one' })).toBeDefined();
  });
});

describe('ViewModeToggle (frozen at WP17)', () => {
  it('marks the active view with aria-pressed, so the state is not colour-only', () => {
    render(wrap(<ViewModeToggle mode="table" onChange={() => undefined} />));
    // Query by accessible name, not index: the name is what a screen-reader user actually gets,
    // and an index silently follows any markup change.
    expect(screen.getByRole('button', { name: M.tableView }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: M.cardView }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('reports the mode the user picked', () => {
    const onChange = vi.fn();
    render(wrap(<ViewModeToggle mode="table" onChange={onChange} />));
    fireEvent.click(screen.getByRole('button', { name: M.cardView }));
    expect(onChange).toHaveBeenCalledWith('card');
  });

  it('labels itself from messages, not hardcoded English', () => {
    render(wrap(<ViewModeToggle mode="card" onChange={() => undefined} />));
    expect(screen.getByLabelText(M.viewMode)).toBeDefined();
  });
});

describe('useViewMode persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to table when nothing is stored', () => {
    const { result } = renderHook(() => useViewMode('k1'));
    expect(result.current[0]).toBe('table');
  });

  it('persists a choice and reads it back under the same key', () => {
    const { result } = renderHook(() => useViewMode('k2'));
    act(() => {
      result.current[1]('card');
    });
    expect(result.current[0]).toBe('card');
    expect(window.localStorage.getItem('k2')).toBe('card');
    expect(renderHook(() => useViewMode('k2')).result.current[0]).toBe('card');
  });

  it('keeps preferences separate per key, so two pages never share one', () => {
    const a = renderHook(() => useViewMode('page-a'));
    act(() => {
      a.result.current[1]('card');
    });
    expect(renderHook(() => useViewMode('page-b')).result.current[0]).toBe('table');
  });

  it('ignores a corrupt stored value rather than rendering an unknown mode', () => {
    window.localStorage.setItem('k3', 'not-a-mode');
    expect(renderHook(() => useViewMode('k3')).result.current[0]).toBe('table');
  });

  it('survives localStorage throwing — Safari private mode throws rather than returning null', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => renderHook(() => useViewMode('k4'))).not.toThrow();
    spy.mockRestore();
  });

  it('still switches view when persistence fails', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useViewMode('k5'));
    act(() => {
      result.current[1]('card');
    });
    expect(result.current[0]).toBe('card');
    spy.mockRestore();
  });

  it('the frozen union is exactly table | card', () => {
    const modes: ViewMode[] = ['table', 'card'];
    expect(modes).toHaveLength(2);
  });
});

describe('DataTable rows as links (getRowHref)', () => {
  // Outside Next's bundler `next/link` is the pages-router Link, which hands clicks to the router in
  // `RouterContext` and ignores them (leaving navigation to the browser) when there is none. Only
  // `push`, `replace` and `prefetch` are ever called on it here, so that is all the stand-in has.
  const push = vi.fn();
  const router = {
    push,
    replace: vi.fn(),
    prefetch: () => Promise.resolve(),
  } as unknown as NextRouter;
  const menuClick = vi.fn();
  const LINK_COLUMNS: ColumnDef<Row>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => <a href={`/named/${row.original.name}`}>{row.original.name}</a>,
    },
    { accessorKey: 'status', header: 'Status' },
    {
      id: 'actions',
      cell: () => (
        <button type="button" onClick={menuClick}>
          {'row menu'}
        </button>
      ),
    },
  ];
  const ROWS: Row[] = [
    { name: 'orders', status: 'ACTIVE' },
    { name: 'billing', status: 'DISABLED' },
  ];

  function LinkHarness({ getRowHref }: { getRowHref?: (row: Row) => string | undefined }) {
    const table = useReactTable({ data: ROWS, columns: LINK_COLUMNS, getCoreRowModel: getCoreRowModel() });
    return (
      <RouterContext.Provider value={router}>
        <DataTable
          table={table}
          isLoading={false}
          isError={false}
          emptyMessage="Nothing here"
          getRowHref={getRowHref}
        />
      </RouterContext.Provider>
    );
  }
  const hiddenLinks = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
  const hiddenLink = (index: number): HTMLAnchorElement => {
    const el = hiddenLinks()[index];
    if (!el) throw new Error(`no row link at ${String(index)}`);
    return el;
  };
  /**
   * Clicks, and reports whether the app's own handlers had already cancelled the browser default
   * (a navigation) by the time the click reached `document`. It then cancels it itself, because jsdom
   * cannot navigate and would only print "not implemented".
   */
  function clickAndSeeIfDefaultWasPrevented(el: Element, init?: MouseEventInit) {
    let prevented: boolean | undefined;
    const record = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', record);
    fireEvent.click(el, init);
    document.removeEventListener('click', record);
    return prevented;
  }
  /** What reaches the first row's hidden link, with the modifiers it carried; the default is cancelled so jsdom does not navigate. */
  function watchHiddenLink(index = 0) {
    const seen: { ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; prevented: boolean }[] = [];
    hiddenLink(index).addEventListener('click', (event) => {
      seen.push({ ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, prevented: event.defaultPrevented });
    });
    return seen;
  }
  const rowMenu = (): HTMLElement => {
    const [first] = screen.getAllByRole('button', { name: 'row menu' });
    if (!first) throw new Error('no row menu button');
    return first;
  };
  const settle = () => {
    act(() => {
      vi.advanceTimersByTime(ROW_CLICK_DELAY_MS + 10);
    });
  };

  beforeEach(() => {
    push.mockClear();
    menuClick.mockClear();
    stubViewport(false);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  it("gives each row a hidden link to that row's href, and nothing over the row", () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    expect(hiddenLinks().map((a) => a.getAttribute('href'))).toEqual(['/apis/orders', '/apis/billing']);
    for (const a of hiddenLinks()) {
      expect(a.hidden).toBe(true);
      expect(a.className).not.toContain('absolute');
    }
  });

  it('adds nothing to rows when no href is given', () => {
    render(wrap(<LinkHarness />));
    expect(hiddenLinks()).toHaveLength(0);
    expect(screen.getAllByRole('row')[1]?.className ?? '').not.toContain('cursor-pointer');
  });

  it('adds nothing to a row whose href is undefined', () => {
    render(wrap(<LinkHarness getRowHref={(row) => (row.name === 'orders' ? '/apis/orders' : undefined)} />));
    expect(hiddenLinks().map((a) => a.getAttribute('href'))).toEqual(['/apis/orders']);
  });

  it('shows a linked row as clickable', () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    expect(screen.getByText('ACTIVE').closest('tr')?.className).toContain('cursor-pointer');
  });

  it("opens the row through the app's Link when its text is clicked, after the double-click window", () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    fireEvent.click(screen.getByText('DISABLED'), { detail: 1 });
    expect(push).not.toHaveBeenCalled();
    settle();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toBe('/apis/billing');
  });

  it('does not open the row for a double click or a triple click: the text is being selected', () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const cell = screen.getByText('DISABLED');
    fireEvent.click(cell, { detail: 1 });
    fireEvent.click(cell, { detail: 2 });
    fireEvent.click(cell, { detail: 3 });
    settle();
    expect(push).not.toHaveBeenCalled();
  });

  it('does not open the row when its text has been selected', () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const cell = screen.getByText('DISABLED');
    window.getSelection()?.selectAllChildren(cell);
    fireEvent.click(cell, { detail: 1 });
    settle();
    expect(push).not.toHaveBeenCalled();
  });

  it.each([['ctrlKey'], ['metaKey'], ['shiftKey']])(
    'passes a %s click on the row to its link at once, with the modifier, for the browser to open in a new tab or window',
    (modifier) => {
      render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
      const seen = watchHiddenLink(0);
      // Next leaves a modified click to the browser: the default is not prevented and nothing is pushed.
      expect(clickAndSeeIfDefaultWasPrevented(screen.getByText('ACTIVE'), { detail: 1, [modifier]: true })).toBe(false);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ ctrl: modifier === 'ctrlKey', meta: modifier === 'metaKey', shift: modifier === 'shiftKey', prevented: false });
      expect(push).not.toHaveBeenCalled();
    },
  );

  it('opens the row in a new tab on a middle click', () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const seen = watchHiddenLink(0);
    fireEvent(screen.getByText('ACTIVE'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ctrl: true, meta: true });
    expect(push).not.toHaveBeenCalled();
  });

  it('leaves a control inside the row to itself: the control acts once, and the row follows nothing', () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const seen = watchHiddenLink(0);
    fireEvent.click(rowMenu(), { detail: 1 });
    settle();
    // What happened: the menu button ran its own handler, once, and nothing was navigated or even asked to be.
    expect(menuClick).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the row's own link working, to its own destination", () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const own = screen.getByRole('link', { name: 'orders' });
    expect(own.getAttribute('href')).toBe('/named/orders');
    expect(own.hasAttribute('data-row-link')).toBe(false);
    const seen = watchHiddenLink(0);
    // The browser is left to follow it (nothing cancelled its default), and the row adds no second navigation to /apis/orders.
    expect(clickAndSeeIfDefaultWasPrevented(own, { detail: 1 })).toBe(false);
    settle();
    expect(seen).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it('leaves the hidden link out of the tab order and away from assistive technology: the named link is the target', () => {
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    expect(hiddenLinks()).toHaveLength(2);
    for (const a of hiddenLinks()) {
      expect(a.getAttribute('tabindex')).toBe('-1');
      expect(a.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['orders', 'billing']);
  });

  it('lays the phone cards out in a column that can shrink, so one long unbroken name cannot widen the page', () => {
    stubViewport(true);
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const grid = hiddenLink(0).closest('div[class*="grid"]');
    // A bare `grid` has one `auto` column, as wide as its widest card's longest word; `grid-cols-1` is `minmax(0, 1fr)`.
    expect(grid?.className.split(' ')).toEqual(expect.arrayContaining(['grid', 'grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3']));
  });

  it('lets a long unbroken word in a card wrap anywhere, so it cannot widen the card: the name and every value', () => {
    stubViewport(true);
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    const name = screen.getAllByText('orders')[0]?.closest('div.flex-1');
    const value = screen.getByText('ACTIVE').closest('dd');
    // `overflow-wrap: anywhere` is what lowers the min-content width of an unbroken word (`break-word` does not).
    expect(name?.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', '[overflow-wrap:anywhere]']));
    expect(value?.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', '[overflow-wrap:anywhere]']));
    expect(value?.closest('dl')?.className).toContain('grid-cols-[minmax(0,auto)_minmax(0,1fr)]');
    // And no leftover `break-words`, which would suggest the old contract is still in force.
    expect(name?.className).not.toContain('break-words');
  });

  it('works in the card view of a phone as well', () => {
    stubViewport(true);
    render(wrap(<LinkHarness getRowHref={(row) => `/apis/${row.name}`} />));
    expect(screen.queryByRole('table')).toBeNull();
    expect(hiddenLinks().map((a) => a.getAttribute('href'))).toEqual(['/apis/orders', '/apis/billing']);
    fireEvent.click(screen.getByText('ACTIVE'), { detail: 1 });
    settle();
    expect(push.mock.calls.map((call): unknown => call[0])).toEqual(['/apis/orders']);
    // A double click on the card's text selects, a button in it acts alone.
    push.mockClear();
    fireEvent.click(screen.getByText('DISABLED'), { detail: 1 });
    fireEvent.click(screen.getByText('DISABLED'), { detail: 2 });
    fireEvent.click(rowMenu(), { detail: 1 });
    settle();
    expect(push).not.toHaveBeenCalled();
    expect(menuClick).toHaveBeenCalledTimes(1);
  });

  it('renders a plain anchor when the app gives no link component', () => {
    function Bare() {
      const table = useReactTable({ data: ROWS, columns: LINK_COLUMNS, getCoreRowModel: getCoreRowModel() });
      return (
        <BaseDataTable
          table={table}
          labels={{ retry: 'Retry', unexpectedError: 'Oops' }}
          isLoading={false}
          isError={false}
          emptyMessage="Nothing here"
          getRowHref={(row) => `/apis/${row.name}`}
        />
      );
    }
    render(<Bare />);
    expect(hiddenLinks().map((a) => a.tagName)).toEqual(['A', 'A']);
    expect(hiddenLink(0).getAttribute('href')).toBe('/apis/orders');
  });

  it('renders each link with the link component it is given, in the base table and in the app wrapper', () => {
    const seen: string[] = [];
    const Custom: LinkComponent = ({ href, ...rest }) => {
      seen.push(href);
      return <a href={href} data-custom="yes" {...rest} />;
    };
    function WithCustom({ wrapped }: { wrapped: boolean }) {
      const table = useReactTable({ data: ROWS, columns: LINK_COLUMNS, getCoreRowModel: getCoreRowModel() });
      const props = {
        table,
        isLoading: false,
        isError: false,
        emptyMessage: 'Nothing here',
        getRowHref: (row: Row) => `/apis/${row.name}`,
        linkComponent: Custom,
      };
      return wrapped ? (
        <DataTable {...props} />
      ) : (
        <BaseDataTable {...props} labels={{ retry: 'Retry', unexpectedError: 'Oops' }} />
      );
    }
    for (const wrapped of [false, true]) {
      seen.length = 0;
      const { unmount } = render(wrap(<WithCustom wrapped={wrapped} />));
      expect(new Set(seen)).toEqual(new Set(['/apis/orders', '/apis/billing']));
      expect(hiddenLinks().every((a) => a.getAttribute('data-custom') === 'yes')).toBe(true);
      unmount();
    }
  });
});
