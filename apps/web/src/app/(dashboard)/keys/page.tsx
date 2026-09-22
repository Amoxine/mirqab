'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Ban, Eye, MoreHorizontal, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { KeyCreatedDialog } from '@/components/keys/key-created-dialog';
import { KeyFormSheet } from '@/components/keys/key-form-sheet';
import { keyStatusVariant } from '@/components/keys/key-utils';
import { RevokeKeyDialog } from '@/components/keys/revoke-key-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { useApis } from '@/hooks/use-apis';
import { useKeys, type ApiKey } from '@/hooks/use-keys';

const PAGE_SIZE = 20;
/** Radix Select forbids empty-string item values, so "no filter" is a sentinel. */
const ALL = 'ALL';

interface RevokeTarget {
  id: string;
  name: string;
}

type Translate = ReturnType<typeof useTranslations>;

function KeyRowActions({
  apiKey,
  onRevoke,
  t,
}: {
  apiKey: ApiKey;
  onRevoke: (key: ApiKey) => void;
  t: Translate;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">{t('list.openMenu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/keys/${apiKey.id}`}>
            <Eye className="h-4 w-4" />
            {t('list.viewDetails')}
          </Link>
        </DropdownMenuItem>
        {apiKey.status !== 'REVOKED' && (
          <PermissionGate permission="key:revoke">
            <DropdownMenuItem
              onClick={() => {
                onRevoke(apiKey);
              }}
            >
              <Ban className="h-4 w-4" />
              {t('actions.revoke')}
            </DropdownMenuItem>
          </PermissionGate>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_ROWS: ApiKey[] = [];

function getColumns(
  onRevoke: (key: ApiKey) => void,
  t: Translate,
  tCommon: Translate,
): ColumnDef<ApiKey>[] {
  return [
    {
      accessorKey: 'name',
      header: tCommon('name'),
      cell: ({ row }) => (
        <Link href={`/keys/${row.original.id}`} className="font-medium hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'status',
      header: tCommon('status'),
      cell: ({ row }) => (
        <Badge variant={keyStatusVariant(row.original.status)}>
          {t(`status.${row.original.status}`)}
        </Badge>
      ),
    },
    {
      accessorKey: 'apiDefName',
      header: t('list.columns.api'),
      cell: ({ row }) => row.original.apiDefName ?? '—',
    },
    {
      accessorKey: 'expiresAt',
      header: t('list.columns.expires'),
      cell: ({ row }) =>
        row.original.expiresAt ? new Date(row.original.expiresAt).toLocaleDateString() : t('list.never'),
    },
    {
      id: 'actions',
      cell: ({ row }) => <KeyRowActions apiKey={row.original} onRevoke={onRevoke} t={t} />,
    },
  ];
}

function KeysPage() {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [apiFilter, setApiFilter] = useState(ALL);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  // The raw key is returned once by the API; keep it only in memory so the user can copy it.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useKeys(
    page,
    PAGE_SIZE,
    statusFilter === ALL ? undefined : statusFilter,
    apiFilter === ALL ? undefined : apiFilter,
  );
  // ponytail: one page of 100 APIs feeds the filter and the create picker; add search past that.
  const { data: apis, isLoading: apisLoading } = useApis(1, 100);
  const apiList = useMemo(() => apis?.data ?? [], [apis]);
  // Keys can only be created for APIs that are live on the gateway.
  const creatableApis = useMemo(() => apiList.filter((a) => a.status === 'ACTIVE'), [apiList]);

  const columns = useMemo(
    () =>
      getColumns(
        (key) => {
          setRevokeTarget({ id: key.id, name: key.name });
        },
        t,
        tCommon,
      ),
    [t, tCommon],
  );

  const table = useReactTable({
    data: data?.data ?? NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: data?.meta.totalPages ?? 0,
  });

  const totalPages = Math.max(1, data?.meta.totalPages ?? 1);
  const filtered = statusFilter !== ALL || apiFilter !== ALL;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('list.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('list.description')}</p>
        </div>
        <PermissionGate permission="key:create">
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

      <KeyFormSheet
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        apis={creatableApis}
        apisLoading={apisLoading}
        onCreated={setCreatedKey}
      />
      <KeyCreatedDialog
        keyValue={createdKey}
        onClose={() => {
          setCreatedKey(null);
        }}
      />
      <RevokeKeyDialog
        target={revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      />

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t('list.filters.statusLabel')}>
            <SelectValue placeholder={t('list.filters.statusLabel')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('list.filters.allStatuses')}</SelectItem>
            <SelectItem value="ACTIVE">{t('status.ACTIVE')}</SelectItem>
            <SelectItem value="REVOKED">{t('status.REVOKED')}</SelectItem>
            <SelectItem value="EXPIRED">{t('status.EXPIRED')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={apiFilter}
          onValueChange={(v) => {
            setApiFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[220px]" aria-label={t('list.filters.apiLabel')}>
            <SelectValue placeholder={t('list.filters.apiLabel')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('list.filters.allApis')}</SelectItem>
            {apiList.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={filtered ? t('list.emptyFiltered') : t('list.empty')}
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
    </div>
  );
}

export default function KeysPageGated() {
  return (
    <PagePermissionGate permission="key:read">
      <KeysPage />
    </PagePermissionGate>
  );
}
