'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { flexRender, type Table as ReactTable } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface DataTableProps<TData> {
  table: ReactTable<TData>;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  onRetry?: () => void;
  emptyMessage: string;
  skeletonRows?: number;
}

/**
 * Shared table chrome for the dashboard's list pages: header + loading/error/empty/data body.
 * Callers own their columns, data and `useReactTable` config — this owns only the rendering that
 * every list page (apis, keys, audit-logs, tenants) previously repeated identically.
 */
export function DataTable<TData>({
  table,
  isLoading,
  isError,
  error,
  onRetry,
  emptyMessage,
  skeletonRows = 5,
}: DataTableProps<TData>) {
  const columnCount = table.getAllColumns().length;
  const rows = table.getRowModel().rows;
  const t = useTranslations('dashboard.dataTable');
  const tCommon = useTranslations('common');

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
      <TableRow>
        <TableCell colSpan={columnCount} className="h-32 text-center">
          <div className="flex flex-col items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-muted-foreground">{error?.message ?? t('unexpectedError')}</p>
            {onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {tCommon('retry')}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    );
  } else if (rows.length) {
    body = rows.map((row) => (
      <TableRow key={row.id}>
        {row.getVisibleCells().map((cell) => (
          <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
        ))}
      </TableRow>
    ));
  } else {
    body = (
      <TableRow>
        <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
          {emptyMessage}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="w-0 min-w-full rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
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

interface DataTablePaginationProps {
  page: number;
  totalPages: number;
  totalCount?: number;
  onPrevious: () => void;
  onNext: () => void;
}

/** Shared "Page X of Y (N total)" + Previous/Next footer for the dashboard's list pages. */
export function DataTablePagination({
  page,
  totalPages,
  totalCount,
  onPrevious,
  onNext,
}: DataTablePaginationProps) {
  const t = useTranslations('dashboard.dataTable');

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        {t('pageOf', { page, totalPages })}
        {totalCount !== undefined && <> {t('totalCount', { count: totalCount })}</>}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={page <= 1}>
          {t('previous')}
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={page >= totalPages}>
          {t('next')}
        </Button>
      </div>
    </div>
  );
}
