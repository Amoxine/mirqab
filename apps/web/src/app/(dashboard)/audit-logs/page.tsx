'use client';

import { useMemo, useState } from 'react';
import {
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Download } from 'lucide-react';
import { format } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { AuditTrafficAction } from '@/components/audit/audit-traffic-action';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageFilter, type FilterField, type FilterValues } from '@open-gateway/ui';
import { toast } from '@/components/ui/sonner';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { PageHeader } from '@/components/shared/page-header';
import { usePageFilterLabels } from '@/hooks/use-page-filter-labels';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { useQuery } from '@tanstack/react-query';
import type { AuditLogEntry } from '@/hooks/use-audit';
import type { PaginatedResponse } from '@/types';
import { AUDIT_ACTION_VALUES, auditActionLabel } from '@/lib/audit-actions';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import type { Locale } from '@/i18n/locales';

/** Full `GET /audit-logs` row: the shared entry plus the columns this page shows. */
type AuditLog = AuditLogEntry & {
  ipAddress: string | null;
  corrId: string | null;
  details: Record<string, unknown> | null;
};

function actionColor(action: string) {
  switch (action) {
    case 'CREATED':
      return 'default';
    case 'UPDATED':
      return 'secondary';
    case 'DELETED':
    case 'REVOKED':
    case 'PERMISSION_REVOKED':
    case 'QUOTA_EXCEEDED':
      return 'destructive';
    case 'LOGIN':
    case 'LOGOUT':
      return 'outline';
    case 'ROLE_CHANGED':
      return 'secondary';
    case 'SYNC_SUCCEEDED':
      return 'default';
    case 'SYNC_FAILED':
      return 'destructive';
    default:
      return 'outline';
  }
}

const NO_ROWS: AuditLog[] = [];

function useAuditLogColumns(): ColumnDef<AuditLog>[] {
  const t = useTranslations('analytics');
  const locale = dateFnsLocale(useLocale() as Locale);
  return useMemo(
    () => [
      {
        accessorKey: 'createdAt',
        header: t('auditLogs.columns.timestamp'),
        cell: ({ row }) =>
          format(new Date(row.original.createdAt), 'MMM dd, yyyy HH:mm', { locale }),
      },
      {
        id: 'user',
        header: t('auditLogs.columns.user'),
        cell: ({ row }) =>
          row.original.user ? (
            <span dir="ltr">{row.original.user.email}</span>
          ) : (
            t('auditLogs.systemUser')
          ),
      },
      {
        accessorKey: 'action',
        header: t('auditLogs.action'),
        cell: ({ row }) => (
          <Badge variant={actionColor(row.original.action)}>
            {auditActionLabel(t, row.original.action)}
          </Badge>
        ),
      },
      {
        accessorKey: 'resource',
        header: t('auditLogs.columns.resource'),
        cell: ({ row }) => (
          <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{row.original.resource}</code>
        ),
      },
      {
        accessorKey: 'ipAddress',
        header: t('auditLogs.columns.ipAddress'),
        cell: ({ row }) =>
          row.original.ipAddress ? <span dir="ltr">{row.original.ipAddress}</span> : '—',
      },
      {
        id: 'actions',
        cell: ({ row }) => <AuditTrafficAction row={row.original} />,
      },
    ],
    [t, locale],
  );
}

function useAuditLogs(
  page: number,
  pageSize: number,
  filters: { resource?: string; action?: string; dateFrom?: string; dateTo?: string },
) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (filters.resource) params.set('resource', filters.resource);
  if (filters.action) params.set('action', filters.action);
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);

  return useQuery({
    queryKey: queryKeys.audit.lists(Object.fromEntries(params.entries())),
    queryFn: () =>
      api
        .get<PaginatedResponse<AuditLog>>(`/audit-logs?${params.toString()}`)
        .then((res) => res.data),
  });
}

function AuditLogsView() {
  const t = useTranslations('analytics');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [filters, setFilters] = useState<FilterValues>({});
  const str = (value: FilterValues[string]) => (typeof value === 'string' ? value : undefined);
  const dateFrom = str(filters.dateFrom);
  const dateTo = str(filters.dateTo);

  const [exporting, setExporting] = useState(false);

  const { data, isLoading, isError, error, refetch } = useAuditLogs(page, pageSize, {
    resource: str(filters.resource),
    action: str(filters.action),
    dateFrom,
    dateTo,
  });

  const columns = useAuditLogColumns();
  const table = useReactTable({
    data: data?.data ?? NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true,
    pageCount: data?.meta.totalPages ?? 0,
  });

  // Server-side export: every row in the date range (up to the API cap), not just the page on screen.
  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const query = params.toString();
      const blob = await api.getBlob(`/audit-logs/export/csv${query ? `?${query}` : ''}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-logs-${format(new Date(), 'yyyy-MM-dd')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('auditLogs.exportError'));
    } finally {
      setExporting(false);
    }
  };

  const clearFilters = () => {
    setFilters({});
    setPage(1);
  };

  const hasActiveFilters = Object.values(filters).some((value) => value !== undefined);
  const filterLabels = {
    ...usePageFilterLabels(t('auditLogs.clearAll')),
    title: t('auditLogs.filters'),
  };
  const filterFields: FilterField[] = [
    {
      type: 'search',
      key: 'resource',
      label: t('auditLogs.resource'),
      placeholder: t('auditLogs.resourcePlaceholder'),
    },
    {
      type: 'select',
      key: 'action',
      label: t('auditLogs.action'),
      allLabel: t('auditLogs.allActions'),
      options: AUDIT_ACTION_VALUES.map((value) => ({
        value,
        label: auditActionLabel(t, value),
      })),
    },
    { type: 'date', key: 'dateFrom', label: t('auditLogs.dateFrom') },
    { type: 'date', key: 'dateTo', label: t('auditLogs.dateTo') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('auditLogs.title')}
        description={t('auditLogs.subtitle')}
        actions={
          <PermissionGate permission="audit:export">
            <Button
              variant="outline"
              loading={exporting}
              title={t('auditLogs.exportHint')}
              onClick={() => {
                void handleExport();
              }}
            >
              {!exporting && <Download className="h-4 w-4" aria-hidden="true" />}
              {exporting ? t('auditLogs.exporting') : t('auditLogs.export')}
            </Button>
          </PermissionGate>
        }
      />

      <div>
        <PageFilter
          layout="popover"
          fields={filterFields}
          values={filters}
          onChange={(patch) => {
            setFilters((current) => ({ ...current, ...patch }));
            setPage(1);
          }}
          onReset={clearFilters}
          labels={filterLabels}
        />
      </div>

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={t('auditLogs.empty')}
        emptyAction={
          hasActiveFilters ? (
            <Button type="button" variant="outline" onClick={clearFilters}>
              {t('auditLogs.clearAll')}
            </Button>
          ) : undefined
        }
      />

      <DataTablePagination
        page={page}
        totalPages={data?.meta.totalPages ?? 1}
        totalCount={data?.meta.totalCount}
        onPrevious={() => {
          setPage((p) => Math.max(1, p - 1));
        }}
        onNext={() => {
          setPage((p) => p + 1);
        }}
      />
    </div>
  );
}

export default function AuditLogsPage() {
  return (
    <PagePermissionGate permission="audit:read">
      <AuditLogsView />
    </PagePermissionGate>
  );
}
