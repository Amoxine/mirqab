'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Archive, MoreHorizontal, Pencil, Play, Plus, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { TenantFormSheet } from '@/components/tenants/tenant-form-sheet';
import { TenantStatusDialog } from '@/components/tenants/tenant-status-dialog';
import { useTenants, type Tenant } from '@/hooks/use-tenants';

function tenantStatusColor(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'SUSPENDED':
      return 'destructive';
    default:
      return 'outline';
  }
}

const NO_ROWS: Tenant[] = [];

type Translate = ReturnType<typeof useTranslations>;

interface StatusTarget {
  tenant: { id: string; name: string };
  action: 'suspend' | 'reactivate' | 'archive';
}

function TenantRowActions({
  tenant,
  onEdit,
  onStatusChange,
  t,
  tCommon,
}: {
  tenant: Tenant;
  onEdit: (tenant: Tenant) => void;
  onStatusChange: (target: StatusTarget) => void;
  t: Translate;
  tCommon: Translate;
}) {
  if (tenant.status === 'ARCHIVED') return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">{t('list.openMenu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PermissionGate permission="tenant:update">
          <DropdownMenuItem
            onClick={() => {
              onEdit(tenant);
            }}
          >
            <Pencil className="h-4 w-4" />
            {tCommon('edit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              onStatusChange({
                tenant,
                action: tenant.status === 'SUSPENDED' ? 'reactivate' : 'suspend',
              });
            }}
          >
            {tenant.status === 'SUSPENDED' ? (
              <Play className="h-4 w-4" />
            ) : (
              <ShieldOff className="h-4 w-4" />
            )}
            {tenant.status === 'SUSPENDED' ? t('actions.reactivate') : t('actions.suspend')}
          </DropdownMenuItem>
        </PermissionGate>
        <PermissionGate permission="tenant:delete">
          <DropdownMenuItem
            onClick={() => {
              onStatusChange({ tenant, action: 'archive' });
            }}
          >
            <Archive className="h-4 w-4" />
            {t('actions.archive')}
          </DropdownMenuItem>
        </PermissionGate>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getColumns(
  onEdit: (tenant: Tenant) => void,
  onStatusChange: (target: StatusTarget) => void,
  t: Translate,
  tCommon: Translate,
): ColumnDef<Tenant>[] {
  return [
    {
      accessorKey: 'name',
      header: tCommon('name'),
      cell: ({ row }) => (
        <Link href={`/tenants/${row.original.id}`} className="min-w-0">
          <p className="font-medium hover:underline">{row.original.name}</p>
          <p className="text-xs text-muted-foreground">{'/'}{row.original.slug}</p>
        </Link>
      ),
    },
    {
      accessorKey: 'status',
      header: tCommon('status'),
      cell: ({ row }) => (
        <Badge variant={tenantStatusColor(row.original.status)}>
          {t(`status.${row.original.status}`)}
        </Badge>
      ),
    },
    {
      accessorKey: 'plan',
      header: t('fields.plan'),
      cell: ({ row }) => <Badge variant="outline">{t(`plan.${row.original.plan}`)}</Badge>,
    },
    {
      accessorKey: 'createdAt',
      header: tCommon('createdAt'),
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <TenantRowActions
          tenant={row.original}
          onEdit={onEdit}
          onStatusChange={onStatusChange}
          t={t}
          tCommon={tCommon}
        />
      ),
    },
  ];
}

function TenantsView() {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Tenant | null>(null);
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);

  const { data, isLoading, isError, error, refetch } = useTenants(page, pageSize);

  const columns = useMemo(
    () => getColumns(setEditTarget, setStatusTarget, t, tCommon),
    [t, tCommon],
  );

  const table = useReactTable({
    data: data?.data ?? NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true,
    pageCount: data?.meta.totalPages ?? 0,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('list.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('list.description')}</p>
        </div>
        <PermissionGate permission="tenant:create">
          <Button
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus className="me-2 h-4 w-4" />
            {t('list.createButton')}
          </Button>
        </PermissionGate>
      </div>

      <TenantFormSheet mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <TenantFormSheet
          mode="edit"
          tenant={editTarget}
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
        />
      )}
      <TenantStatusDialog
        tenant={statusTarget?.tenant ?? null}
        action={statusTarget?.action ?? 'suspend'}
        onClose={() => {
          setStatusTarget(null);
        }}
      />

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={t('list.empty')}
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

export default function TenantsPage() {
  return (
    <PagePermissionGate permission="tenant:read">
      <TenantsView />
    </PagePermissionGate>
  );
}
