'use client';

import { useMemo, useState } from 'react';
import {
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Download, Filter } from 'lucide-react';
import { format } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { useQuery } from '@tanstack/react-query';
import type { AuditLogEntry } from '@/hooks/use-audit';
import type { PaginatedResponse } from '@/types';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import type { Locale } from '@/i18n/locales';

/** Full `GET /audit-logs` row: the shared entry plus the columns this page shows. */
type AuditLog = AuditLogEntry & {
  ipAddress: string | null;
  corrId: string | null;
  details: Record<string, unknown> | null;
};

/** Prisma `AuditAction` enum values (the API 500s on anything else); labels come from `auditLogs.actions.*`. */
const ACTION_VALUES = [
  'CREATED',
  'UPDATED',
  'DELETED',
  'REVOKED',
  'ASSIGNED',
  'UNASSIGNED',
  'LOGIN',
  'LOGOUT',
  'ROLE_CHANGED',
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'QUOTA_EXCEEDED',
  'SYNC_SUCCEEDED',
  'SYNC_FAILED',
] as const;

// ponytail: `AuditLogEntry.action` is typed wider than this list (see use-audit.ts) since the API's
// enum can grow independently — an action outside it falls back to the raw value instead of a missing-key warning.
function actionLabel(t: ReturnType<typeof useTranslations>, action: string): string {
  return (ACTION_VALUES as readonly string[]).includes(action) ? t(`auditLogs.actions.${action}`) : action;
}

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
        cell: ({ row }) => format(new Date(row.original.createdAt), 'MMM dd, yyyy HH:mm', { locale }),
      },
      {
        id: 'user',
        header: t('auditLogs.columns.user'),
        cell: ({ row }) => row.original.user?.email ?? t('auditLogs.systemUser'),
      },
      {
        accessorKey: 'action',
        header: t('auditLogs.action'),
        cell: ({ row }) => (
          <Badge variant={actionColor(row.original.action)}>{actionLabel(t, row.original.action)}</Badge>
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
        cell: ({ row }) => row.original.ipAddress ?? '—',
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
  const [resourceFilter, setResourceFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [exporting, setExporting] = useState(false);

  const { data, isLoading, isError, error, refetch } = useAuditLogs(page, pageSize, {
    resource: resourceFilter || undefined,
    action: actionFilter || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
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
    setResourceFilter('');
    setActionFilter('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const hasActiveFilters = resourceFilter || actionFilter || dateFrom || dateTo;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('auditLogs.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('auditLogs.subtitle')}</p>
        </div>
        <PermissionGate permission="audit:export">
          <Button
            variant="outline"
            disabled={exporting}
            title={t('auditLogs.exportHint')}
            onClick={() => {
              void handleExport();
            }}
          >
            <Download className="me-2 h-4 w-4" />
            {exporting ? t('auditLogs.exporting') : t('auditLogs.export')}
          </Button>
        </PermissionGate>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="me-2 h-4 w-4" />
              {t('auditLogs.filters')}
              {hasActiveFilters && (
                <span className="bg-primary text-primary-foreground ms-1 flex h-5 w-5 items-center justify-center rounded-full text-xs">
                  {[resourceFilter, actionFilter, dateFrom, dateTo].filter(Boolean).length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="start">
            <div className="space-y-4">
              <h4 className="font-medium">{t('auditLogs.filterOptions')}</h4>
              <div className="space-y-2">
                <label htmlFor="audit-filter-resource" className="text-muted-foreground text-sm">
                  {t('auditLogs.resource')}
                </label>
                <Input
                  id="audit-filter-resource"
                  placeholder={t('auditLogs.resourcePlaceholder')}
                  value={resourceFilter}
                  onChange={(e) => {
                    setResourceFilter(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-filter-action" className="text-muted-foreground text-sm">
                  {t('auditLogs.action')}
                </label>
                <Select
                  value={actionFilter || 'ALL'}
                  onValueChange={(v) => {
                    setActionFilter(v === 'ALL' ? '' : v);
                    setPage(1);
                  }}
                >
                  <SelectTrigger id="audit-filter-action">
                    <SelectValue placeholder={t('auditLogs.actionPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('auditLogs.allActions')}</SelectItem>
                    {ACTION_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {actionLabel(t, value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <label htmlFor="audit-filter-from" className="text-muted-foreground text-sm">
                    {t('auditLogs.dateFrom')}
                  </label>
                  <Input
                    id="audit-filter-from"
                    type="date"
                    value={dateFrom}
                    onChange={(e) => {
                      setDateFrom(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="audit-filter-to" className="text-muted-foreground text-sm">
                    {t('auditLogs.dateTo')}
                  </label>
                  <Input
                    id="audit-filter-to"
                    type="date"
                    value={dateTo}
                    onChange={(e) => {
                      setDateTo(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  disabled={!hasActiveFilters}
                >
                  {t('auditLogs.clearAll')}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={t('auditLogs.empty')}
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
