'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { flexRender, type Row, type Table as ReactTable } from '@tanstack/react-table';
import { AlertTriangle, Inbox, LayoutGrid, Table2 } from 'lucide-react';
import { useMediaQuery } from '../lib/use-media-query';
import { Button } from './button';
import { Card, CardContent } from './card';
import { RowLink, rowLinkProps, type LinkComponent } from './row-link';
import { Skeleton } from './skeleton';
import { StateMessage } from './state-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

/**
 * FROZEN AT WP17 (labels became props when this moved to packages/ui). This is the contract later work packages build on, so what "frozen" means is
 * spelled out rather than implied:
 *
 *   FROZEN — will not change shape without its own work package:
 *     • the `ViewMode` union is exactly `'table' | 'card'`; no third member is added silently
 *     • `useViewMode(storageKey)` returns exactly `[mode, setMode]`, in that order
 *     • `<ViewModeToggle mode onChange />` — those three props, those names
 *     • `<DataTable renderCard />` is OPTIONAL; omitting it keeps a table-only component, so every
 *       existing caller compiles untouched
 *     • persistence is per `storageKey`, so two pages never share a preference
 *
 *   NOT frozen — free to change:
 *     • the markup and classes either component renders
 *     • the storage mechanism behind `useViewMode` (localStorage today)
 *     • anything else in this file
 *
 * A later WP wanting a third view adds its own component rather than widening this union, because
 * every `renderCard` caller would otherwise have to handle a mode it was never written for.
 */
export type ViewMode = 'table' | 'card';

/**
 * Remembered table/card preference, per page.
 *
 * Reads on mount rather than during render: the server render has no localStorage, and seeding
 * state from it directly would make the first client render disagree with the server's HTML and
 * trip a hydration mismatch. Every access is guarded — Safari in private mode throws on
 * `localStorage` rather than returning null, and a table that cannot render because of a remembered
 * preference is a worse failure than forgetting the preference.
 */
export function useViewMode(storageKey: string): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>('table');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === 'table' || stored === 'card') setModeState(stored);
    } catch {
      // No stored preference available; the default stands.
    }
  }, [storageKey]);

  const setMode = useCallback(
    (next: ViewMode) => {
      setModeState(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Preference is not persisted; the current view still changes.
      }
    },
    [storageKey],
  );

  return [mode, setMode];
}

/** Table/card switch. Pure presentation — the caller owns the state, via `useViewMode` or its own. */
export interface ViewModeLabels {
  /** Name of the group. */
  group: string;
  table: string;
  card: string;
}

export function ViewModeToggle({
  mode,
  onChange,
  labels,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  labels: ViewModeLabels;
}) {
  return (
    // Hidden on phones: every table already renders as cards there, so the switch would do nothing.
    <div className="hidden rounded-md border sm:inline-flex" role="group" aria-label={labels.group}>
      <Button
        type="button"
        variant={mode === 'table' ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={mode === 'table'}
        title={labels.table}
        onClick={() => {
          onChange('table');
        }}
      >
        <Table2 className="h-4 w-4" />
        <span className="sr-only">{labels.table}</span>
      </Button>
      <Button
        type="button"
        variant={mode === 'card' ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={mode === 'card'}
        title={labels.card}
        onClick={() => {
          onChange('card');
        }}
      >
        <LayoutGrid className="h-4 w-4" />
        <span className="sr-only">{labels.card}</span>
      </Button>
    </div>
  );
}

export interface DataTableLabels {
  retry: string;
  /** Shown when the query failed without an error message of its own. */
  unexpectedError: string;
}

export interface DataTableProps<TData> {
  table: ReactTable<TData>;
  labels: DataTableLabels;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  onRetry?: () => void;
  emptyMessage: string;
  /** Next step shown under the empty message — typically the page's (permission-gated) create button. */
  emptyAction?: ReactNode;
  skeletonRows?: number;
  /** Current view. Omit for table-only, which is what every pre-WP17 caller gets. */
  viewMode?: ViewMode;
  /** Card renderer for one row. Required to use `viewMode: 'card'`; without it the table renders. */
  renderCard?: (row: TData) => ReactNode;
  /**
   * Where a row leads. A click on the row (and, in card view, on the card) then follows it, through a
   * real link, in both views: a plain click after a short wait for a possible second click, Ctrl, Cmd,
   * Shift or middle click as a new tab or window. Controls inside the row keep their own action, and
   * the row's text stays selectable (a double click, a triple click or a drag selects, it does not
   * navigate). The row's own named link, usually its name, is the keyboard target for the same
   * destination (see `RowLink`), so a row that uses this must carry one.
   */
  getRowHref?: (row: TData) => string | undefined;
  /** Renders the row link; the app passes its router's `Link` for client-side navigation. Default: a plain `<a>`. */
  linkComponent?: LinkComponent;
}

/**
 * Label/value card for one row, built from the table's own column headers — what every table falls
 * back to on phones when the caller has no `renderCard`, instead of a table wider than the screen.
 * A header-less column (the row-actions menu) goes to the card's top corner.
 */
function AutoCard<TData>({ table, row }: { table: ReactTable<TData>; row: Row<TData> }) {
  const headers = table.getFlatHeaders();
  const cells = row.getVisibleCells();
  const labelled = cells.filter((cell) => cell.column.columnDef.header);
  const unlabelled = cells.filter((cell) => !cell.column.columnDef.header);
  const [first, ...rest] = labelled;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 break-words">
            {first && flexRender(first.column.columnDef.cell, first.getContext())}
          </div>
          {unlabelled.map((cell) => (
            <div key={cell.id} className="-me-2 -mt-2 shrink-0">
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          ))}
        </div>
        {rest.length > 0 && (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {rest.map((cell) => {
              const header = headers.find((h) => h.column.id === cell.column.id);
              return (
                <div key={cell.id} className="contents">
                  <dt className="text-muted-foreground">
                    {header ? flexRender(cell.column.columnDef.header, header.getContext()) : null}
                  </dt>
                  <dd className="min-w-0 break-words text-end">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Shared table chrome for the dashboard's list pages: header + loading/error/empty/data body.
 * Callers own their columns, data and `useReactTable` config — this owns only the rendering that
 * every list page (apis, keys, audit-logs, tenants) previously repeated identically.
 *
 * Below `sm` rows always render as cards — the caller's `renderCard` when given, else `AutoCard` —
 * so no list page needs a horizontally-scrolling table on a phone.
 */
export function DataTable<TData>({
  table,
  labels,
  isLoading,
  isError,
  error,
  onRetry,
  emptyMessage,
  emptyAction,
  skeletonRows = 5,
  viewMode = 'table',
  renderCard,
  getRowHref,
  linkComponent,
}: DataTableProps<TData>) {
  const columnCount = table.getAllColumns().length;
  const rows = table.getRowModel().rows;
  // Below Tailwind's `sm` breakpoint.
  const isNarrow = useMediaQuery('(max-width: 639px)');

  let body: ReactNode;
  if (isLoading) {
    body = Array.from({ length: skeletonRows }).map((_, i) => (
      <TableRow key={i}>
        {Array.from({ length: columnCount }).map((_col, j) => (
          <TableCell key={j}>
            <Skeleton className="h-5 w-24" />
          </TableCell>
        ))}
      </TableRow>
    ));
  } else if (isError) {
    body = (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={columnCount} className="whitespace-normal">
          <StateMessage
            role="alert"
            icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
            message={error?.message ?? labels.unexpectedError}
          >
            {onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {labels.retry}
              </Button>
            )}
          </StateMessage>
        </TableCell>
      </TableRow>
    );
  } else if (rows.length) {
    body = rows.map((row) => {
      const href = getRowHref?.(row.original);
      return (
        <TableRow key={row.id} {...(href ? rowLinkProps() : undefined)}>
          {row.getVisibleCells().map((cell, index) => (
            <TableCell key={cell.id}>
              {/* Any cell would do: the link is hidden, the row's click handler follows it. */}
              {href && index === 0 ? <RowLink href={href} linkComponent={linkComponent} /> : null}
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </TableCell>
          ))}
        </TableRow>
      );
    });
  } else {
    body = (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={columnCount} className="whitespace-normal">
          <StateMessage icon={<Inbox aria-hidden="true" />} message={emptyMessage}>
            {emptyAction}
          </StateMessage>
        </TableCell>
      </TableRow>
    );
  }

  // Card mode only applies to real rows: loading, error and empty are one shared presentation, and
  // duplicating them per view is how the two drift apart.
  const hasRows = !isLoading && !isError && rows.length > 0;
  if (isLoading && isNarrow) {
    // Same shape as the cards that will replace it, so nothing jumps when the data lands.
    return (
      <div className="grid gap-4" aria-busy="true">
        {Array.from({ length: Math.min(skeletonRows, 3) }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (hasRows && ((viewMode === 'card' && renderCard) || isNarrow)) {
    return (
      // `grid-cols-1` is `minmax(0, 1fr)`: the bare grid's one column is `auto`, which is as wide as its widest card's
      // longest unbroken word, so one long name would widen the column (and the page) past the screen.
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const href = getRowHref?.(row.original);
          return (
            <div
              key={row.id}
              {...(href
                ? rowLinkProps('rounded-[1.25rem] transition-shadow hover:shadow-md')
                : undefined)}
            >
              {href ? <RowLink href={href} linkComponent={linkComponent} /> : null}
              {renderCard ? renderCard(row.original) : <AutoCard table={table} row={row} />}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="bg-card w-0 min-w-full rounded-md border" aria-busy={isLoading || undefined}>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>{body}</TableBody>
      </Table>
    </div>
  );
}

export interface DataTablePaginationProps {
  page: number;
  totalPages: number;
  /** "Page 2 of 5 (98 total)" — formatted by the caller, in its own language and number format. */
  summary: ReactNode;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
}

/** "Page X of Y" summary with Previous / Next, for list pages. */
export function DataTablePagination({
  page,
  totalPages,
  summary,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
}: DataTablePaginationProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {summary}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={page <= 1}>
          {previousLabel}
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={page >= totalPages}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
