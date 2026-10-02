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
import { SpecUpdateBadge } from '@/components/apis/spec-source/spec-update-banner';
import { SyncStatusBadge } from '@/components/apis/sync-status-badge';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/sonner';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { PageHeader } from '@/components/shared/page-header';
import { PageFilter, type FilterField, type FilterValues } from '@open-gateway/ui';
import { useApis, useSetApiStatus, type ApiDefinition } from '@/hooks/use-apis';
import { usePageFilterLabels } from '@/hooks/use-page-filter-labels';
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
  const [filters, setFilters] = useState<FilterValues>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiDefinition | null>(null);

  const { data, isLoading, isError, error, refetch } = useApis(
    page,
    PAGE_SIZE,
    typeof filters.status === 'string' ? filters.status : undefined,
    typeof filters.sync === 'string' ? filters.sync : undefined,
  );
  // `mutateAsync` is stable across renders, which keeps `columns` below from being rebuilt every render.
  const { mutateAsync: setApiStatus } = useSetApiStatus();

  const handleToggleStatus = useCallback(
    async (item: ApiDefinition) => {
      const next = item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
      try {
        const saved = await setApiStatus({ id: item.id, status: next });
        toastSyncOutcome(
          t,
          saved,
          next === 'ACTIVE' ? t('actions.activatedToast') : t('actions.disabledToast'),
        );
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
            <Link
              href={`/apis/${row.original.id}`}
              className="rounded-sm font-medium hover:underline"
            >
              {row.original.name}
            </Link>
            <p className="text-muted-foreground font-mono text-xs">
              {'/'}
              {row.original.slug}
            </p>
            {row.original.specUpdateAvailable && <SpecUpdateBadge />}
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
        cell: ({ row }) => (
          <ApiRowActions
            item={row.original}
            onToggleStatus={handleToggleStatus}
            onDelete={setDeleteTarget}
          />
        ),
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
  const filtered = Object.values(filters).some((value) => value !== undefined);
  const filterLabels = usePageFilterLabels();
  const filterFields: FilterField[] = [
    {
      type: 'select',
      key: 'status',
      label: t('filters.statusLabel'),
      allLabel: t('status.all'),
      options: [
        { value: 'ACTIVE', label: t('status.active') },
        { value: 'DRAFT', label: t('status.draft') },
        { value: 'DISABLED', label: t('status.disabled') },
      ],
    },
    {
      type: 'select',
      key: 'sync',
      label: t('filters.syncLabel'),
      allLabel: t('sync.all'),
      options: [
        { value: 'SYNCED', label: t('sync.synced') },
        { value: 'PENDING', label: t('sync.pending') },
        { value: 'FAILED', label: t('sync.failed') },
      ],
    },
  ];
  const changeFilters = (patch: FilterValues) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };
  const resetFilters = () => {
    setFilters({});
    setPage(1);
  };

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

      <PageFilter
        layout="inline"
        fields={filterFields}
        values={filters}
        onChange={changeFilters}
        onReset={resetFilters}
        labels={filterLabels}
      />

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        getRowHref={(api) => `/apis/${api.id}`}
        emptyMessage={filtered ? t('empty.filtered') : t('empty.all')}
        emptyAction={
          filtered ? (
            <Button type="button" variant="outline" onClick={resetFilters}>
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
