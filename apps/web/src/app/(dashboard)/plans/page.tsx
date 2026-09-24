'use client';

import { useMemo, useState } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { DeletePlanDialog } from '@/components/plans/delete-plan-dialog';
import { PlanFormSheet } from '@/components/plans/plan-form-sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTable } from '@/components/shared/data-table';
import { usePlans, type Plan } from '@/hooks/use-plans';

const NO_ROWS: Plan[] = [];

type Translate = ReturnType<typeof useTranslations>;

function formatRate(rate: number, per: number, unlimitedLabel: string): string {
  if (rate <= 0) return unlimitedLabel;
  return per === 1 ? `${String(rate)}/s` : `${String(rate)} / ${String(per)}s`;
}

function PlanRowActions({
  plan,
  onEdit,
  onDelete,
  t,
  tCommon,
}: {
  plan: Plan;
  onEdit: (plan: Plan) => void;
  onDelete: (plan: Plan) => void;
  t: Translate;
  tCommon: Translate;
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
        <PermissionGate permission="plan:update">
          <DropdownMenuItem
            onClick={() => {
              onEdit(plan);
            }}
          >
            <Pencil className="h-4 w-4" />
            {tCommon('edit')}
          </DropdownMenuItem>
        </PermissionGate>
        <PermissionGate permission="plan:delete">
          <DropdownMenuItem
            onClick={() => {
              onDelete(plan);
            }}
          >
            <Trash2 className="h-4 w-4" />
            {tCommon('delete')}
          </DropdownMenuItem>
        </PermissionGate>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getColumns(
  onEdit: (plan: Plan) => void,
  onDelete: (plan: Plan) => void,
  t: Translate,
  tCommon: Translate,
): ColumnDef<Plan>[] {
  return [
    {
      accessorKey: 'name',
      header: tCommon('name'),
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{row.original.name}</p>
          {row.original.description && (
            <p className="max-w-xs truncate text-xs text-muted-foreground">{row.original.description}</p>
          )}
        </div>
      ),
    },
    {
      id: 'rate',
      header: t('list.columns.rate'),
      cell: ({ row }) => formatRate(row.original.rate, row.original.per, t('list.unlimited')),
    },
    {
      id: 'quota',
      header: t('list.columns.quota'),
      cell: ({ row }) =>
        row.original.quotaMax < 0 ? t('list.unlimited') : row.original.quotaMax.toLocaleString(),
    },
    {
      accessorKey: 'keyCount',
      header: t('list.columns.keys'),
    },
    {
      accessorKey: 'active',
      header: tCommon('status'),
      cell: ({ row }) => (
        <Badge variant={row.original.active ? 'default' : 'outline'}>
          {row.original.active ? t('list.active') : t('list.inactive')}
        </Badge>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => <PlanRowActions plan={row.original} onEdit={onEdit} onDelete={onDelete} t={t} tCommon={tCommon} />,
    },
  ];
}

function PlansView() {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Plan | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = usePlans();

  const columns = useMemo(
    () =>
      getColumns(
        setEditTarget,
        (p) => {
          setDeleteTarget({ id: p.id, name: p.name });
        },
        t,
        tCommon,
      ),
    [t, tCommon],
  );

  const table = useReactTable({
    data: data ?? NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('list.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('list.description')}</p>
        </div>
        <PermissionGate permission="plan:create">
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

      <PlanFormSheet mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <PlanFormSheet
          mode="edit"
          plan={editTarget}
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
        />
      )}
      <DeletePlanDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
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
    </div>
  );
}

export default function PlansPage() {
  return (
    <PagePermissionGate permission="plan:read">
      <PlansView />
    </PagePermissionGate>
  );
}
