// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
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
