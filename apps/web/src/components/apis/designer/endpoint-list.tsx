'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { DataTable, useViewMode, ViewModeToggle } from '@/components/shared/data-table';
import { Card, CardContent } from '@/components/ui/card';
import type { OasDocument } from '@/types';

interface EndpointRow {
  path: string;
  method: string;
  operationId?: string;
}

const VIEW_STORAGE_KEY = 'og:apis-designer:endpoints-view';
const NO_ROWS: EndpointRow[] = [];

/** Flattens `oasDocument.paths` (path -> method -> operation) into one row per path+method. */
function toRows(oasDocument: OasDocument | null): EndpointRow[] {
  const paths = oasDocument?.paths ?? {};
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      path,
      method: method.toUpperCase(),
      operationId: operation.operationId,
    })),
  );
}

interface EndpointListProps {
  oasDocument: OasDocument | null;
}

/**
 * WP17: the API's endpoints, derived from the generated OAS document — never hand-entered. This
 * product proxies whole upstreams rather than describing per-endpoint contracts, so `paths` is
 * genuinely empty until a WP15a-c middleware needing an operation to hang off (circuit breaker, URL
 * rewrite, mock, body transform, schema validation) is configured, at which point it synthesises one
 * catch-all path (`/.*`) per HTTP method. Full per-path endpoints follow OAS import (WP24).
 */
export function EndpointList({ oasDocument }: EndpointListProps) {
  const t = useTranslations('apis');
  const [viewMode, setViewMode] = useViewMode(VIEW_STORAGE_KEY);
  const rows = useMemo(() => toRows(oasDocument), [oasDocument]);

  const columns = useMemo<ColumnDef<EndpointRow>[]>(
    () => [
      {
        accessorKey: 'method',
        header: t('designer.endpoints.method'),
        cell: ({ row }) => <MethodBadge method={row.original.method} />,
      },
      {
        accessorKey: 'path',
        header: t('designer.endpoints.path'),
        cell: ({ row }) => <span className="break-all font-mono text-xs">{row.original.path}</span>,
      },
      {
        accessorKey: 'operationId',
        header: t('designer.endpoints.operationId'),
        cell: ({ row }) => (
          <span className="break-all font-mono text-xs text-muted-foreground">{row.original.operationId ?? '—'}</span>
        ),
      },
    ],
    [t],
  );

  const table = useReactTable({ data: rows.length ? rows : NO_ROWS, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('designer.endpoints.description')}</p>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>
      <DataTable
        table={table}
        isLoading={false}
        isError={false}
        emptyMessage={t('designer.endpoints.empty')}
        viewMode={viewMode}
        renderCard={(row) => (
          <Card>
            <CardContent className="space-y-2 pt-6">
              <MethodBadge method={row.method} />
              <p className="break-all font-mono text-xs">{row.path}</p>
              {row.operationId && <p className="break-all font-mono text-xs text-muted-foreground">{row.operationId}</p>}
            </CardContent>
          </Card>
        )}
      />
    </div>
  );
}
