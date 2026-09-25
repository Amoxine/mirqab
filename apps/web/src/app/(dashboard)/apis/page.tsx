'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { FileUp, MoreHorizontal, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { ApiFormSheet } from '@/components/apis/api-form-sheet';
import { ApiStatusBadge } from '@/components/apis/api-status-badge';
import { DeleteApiDialog } from '@/components/apis/delete-api-dialog';
import { ImportWizardSheet } from '@/components/apis/import/import-wizard-sheet';
import { SyncStatusBadge } from '@/components/apis/sync-status-badge';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { PageHeader } from '@/components/shared/page-header';
import { useApis, useSetApiStatus, type ApiDefinition } from '@/hooks/use-apis';
import { usePermissions } from '@/hooks/use-permissions';
import { FormattedDate } from '@/components/shared/formatted';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';

const PAGE_SIZE = 20;
const NO_ROWS: ApiDefinition[] = [];

interface ApiRowActionsProps {
  item: ApiDefinition;
  onToggleStatus: (item: ApiDefinition) => void;
  onDelete: (item: ApiDefinition) => void;
}

/** Row menu. A component (not inline in the column cell) so it can use hooks. */
function ApiRowActions({ item, onToggleStatus, onDelete }: ApiRowActionsProps) {
  const { can } = usePermissions();
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const canUpdate = can('api:update');
  const canDelete = can('api:delete');
  if (!canUpdate && !canDelete) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{t('actions.openMenu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canUpdate && (
          <>
            <DropdownMenuItem asChild>
              <Link href={`/apis/${item.id}`}>
                <Pencil className="h-4 w-4" />
                {tCommon('edit')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                onToggleStatus(item);
              }}
            >
              <Power className="h-4 w-4" />
              {item.status === 'ACTIVE' ? t('actions.disable') : t('actions.activate')}
            </DropdownMenuItem>
          </>
        )}
        {canDelete && (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => {
              onDelete(item);
            }}
          >
            <Trash2 className="h-4 w-4" />
            {tCommon('delete')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ApisPage() {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const tOpenapi = useTranslations('openapi');
  const [page, setPage] = useState(1);
  // 'ALL' is the "no filter" sentinel: Radix Select forbids an empty-string item value.
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [syncFilter, setSyncFilter] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiDefinition | null>(null);

  const { data, isLoading, isError, error, refetch } = useApis(
    page,
    PAGE_SIZE,
    statusFilter === 'ALL' ? undefined : statusFilter,
    syncFilter === 'ALL' ? undefined : syncFilter,
  );
  // `mutateAsync` is stable across renders, which keeps `columns` below from being rebuilt every render.
  const { mutateAsync: setApiStatus } = useSetApiStatus();

  const handleToggleStatus = useCallback(
    async (item: ApiDefinition) => {
      const next = item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
      try {
        const saved = await setApiStatus({ id: item.id, status: next });
        toastSyncOutcome(t, saved, next === 'ACTIVE' ? t('actions.activatedToast') : t('actions.disabledToast'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('actions.statusErrorToast'));
      }
    },
    [setApiStatus, t],
  );

  const columns = useMemo<ColumnDef<ApiDefinition>[]>(
    () => [
      {
        accessorKey: 'name',
        header: tCommon('name'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <Link href={`/apis/${row.original.id}`} className="rounded-sm font-medium hover:underline">
              {row.original.name}
            </Link>
            <p className="font-mono text-xs text-muted-foreground">{'/'}{row.original.slug}</p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: tCommon('status'),
        cell: ({ row }) => <ApiStatusBadge status={row.original.status} />,
      },
      {
        accessorKey: 'syncStatus',
        header: t('table.sync'),
        cell: ({ row }) => (
          <SyncStatusBadge
            apiId={row.original.id}
            syncStatus={row.original.syncStatus}
            syncError={row.original.syncError}
          />
        ),
      },
      {
        accessorKey: 'authType',
        header: t('table.authType'),
      },
      {
        accessorKey: 'createdAt',
        header: tCommon('createdAt'),
        cell: ({ row }) => <FormattedDate value={row.original.createdAt} />,
      },
      {
        id: 'actions',
        cell: ({ row }) => <ApiRowActions item={row.original} onToggleStatus={handleToggleStatus} onDelete={setDeleteTarget} />,
      },
    ],
    [handleToggleStatus, t, tCommon],
  );

  const table = useReactTable({
    data: data?.data ?? NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: data?.meta.totalPages ?? 0,
  });

  const totalPages = Math.max(1, data?.meta.totalPages ?? 1);
  const filtered = statusFilter !== 'ALL' || syncFilter !== 'ALL';

  const createButton = (
    <PermissionGate permission="api:create">
      <Button
        variant="outline"
        onClick={() => {
          setImportOpen(true);
        }}
      >
        <FileUp className="h-4 w-4" aria-hidden="true" />
        {tOpenapi('import.button')}
      </Button>
      <Button
        onClick={() => {
          setCreateOpen(true);
        }}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('createButton')}
      </Button>
    </PermissionGate>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} actions={createButton} />

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t('filters.statusLabel')}>
            <SelectValue placeholder={t('filters.statusLabel')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('status.all')}</SelectItem>
            <SelectItem value="ACTIVE">{t('status.active')}</SelectItem>
            <SelectItem value="DRAFT">{t('status.draft')}</SelectItem>
            <SelectItem value="DISABLED">{t('status.disabled')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={syncFilter}
          onValueChange={(value) => {
            setSyncFilter(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t('filters.syncLabel')}>
            <SelectValue placeholder={t('filters.syncPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('sync.all')}</SelectItem>
            <SelectItem value="SYNCED">{t('sync.synced')}</SelectItem>
            <SelectItem value="PENDING">{t('sync.pending')}</SelectItem>
            <SelectItem value="FAILED">{t('sync.failed')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={filtered ? t('empty.filtered') : t('empty.all')}
        emptyAction={
          filtered ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setStatusFilter('ALL');
                setSyncFilter('ALL');
                setPage(1);
              }}
            >
              {tCommon('clearFilters')}
            </Button>
          ) : (
            createButton
          )
        }
      />

      <DataTablePagination
        page={page}
        totalPages={totalPages}
        totalCount={data?.meta.totalCount}
        onPrevious={() => {
          setPage((p) => Math.max(1, p - 1));
        }}
        onNext={() => {
          setPage((p) => p + 1);
        }}
      />

      <ApiFormSheet mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      <ImportWizardSheet open={importOpen} onOpenChange={setImportOpen} />
      <DeleteApiDialog
        api={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

export default function ApisPageGated() {
  return (
    <PagePermissionGate permission="api:read">
      <ApisPage />
    </PagePermissionGate>
  );
}
