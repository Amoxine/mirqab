'use client';

import { useMemo, useState } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { DeleteRoleDialog } from '@/components/roles/delete-role-dialog';
import { RoleFormSheet } from '@/components/roles/role-form-sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { useRoles, type Role } from '@/hooks/use-roles';

const NO_ROWS: Role[] = [];
const RESERVED_ROLE_NAME = 'super_admin';

type Translate = ReturnType<typeof useTranslations>;

function RoleRowActions({
  role,
  onEdit,
  onDelete,
  t,
  tCommon,
}: {
  role: Role;
  onEdit: (role: Role) => void;
  onDelete: (role: Role) => void;
  t: Translate;
  tCommon: Translate;
}) {
  // The reserved system role never shows a menu — nothing here can create, edit or delete it either
  // (see RoleFormSheet / the backend's matching 403), so an actions menu with nothing enabled is worse
  // than none at all.
  if (role.name.toLowerCase() === RESERVED_ROLE_NAME) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{t('list.openMenu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PermissionGate permission="role:update">
          <DropdownMenuItem
            onClick={() => {
              onEdit(role);
            }}
          >
            <Pencil className="h-4 w-4" />
            {tCommon('edit')}
          </DropdownMenuItem>
        </PermissionGate>
        <PermissionGate permission="role:delete">
          <DropdownMenuItem
            disabled={role.memberCount > 0}
            onClick={() => {
              onDelete(role);
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
  onEdit: (role: Role) => void,
  onDelete: (role: Role) => void,
  t: Translate,
  tCommon: Translate,
): ColumnDef<Role>[] {
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
      id: 'permissions',
      header: t('list.columns.permissions'),
      cell: ({ row }) => t('list.permissionCount', { count: row.original.permissions.length }),
    },
    {
      accessorKey: 'memberCount',
      header: t('list.columns.members'),
      cell: ({ row }) => (
        <Badge variant={row.original.memberCount > 0 ? 'default' : 'outline'}>{row.original.memberCount}</Badge>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => <RoleRowActions role={row.original} onEdit={onEdit} onDelete={onDelete} t={t} tCommon={tCommon} />,
    },
  ];
}

function RolesView() {
  const t = useTranslations('roles');
  const tCommon = useTranslations('common');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Role | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = useRoles();

  const columns = useMemo(
    () =>
      getColumns(
        setEditTarget,
        (r) => {
          setDeleteTarget({ id: r.id, name: r.name });
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

  const createButton = (
    <PermissionGate permission="role:create">
      <Button
        onClick={() => {
          setCreateOpen(true);
        }}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('list.createButton')}
      </Button>
    </PermissionGate>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/settings', label: t('backToSettings') }}
        title={t('list.title')}
        description={t('list.description')}
        actions={createButton}
      />

      <RoleFormSheet mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <RoleFormSheet
          mode="edit"
          role={editTarget}
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
        />
      )}
      <DeleteRoleDialog
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
        emptyAction={createButton}
      />
    </div>
  );
}

export default function RolesPage() {
  return (
    <PagePermissionGate permission="role:read">
      <RolesView />
    </PagePermissionGate>
  );
}
