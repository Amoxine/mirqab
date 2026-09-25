'use client';

import { useMemo, useState } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { DeleteProductDialog } from '@/components/products/delete-product-dialog';
import { ProductFormSheet } from '@/components/products/product-form-sheet';
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
import { useProducts, type Product } from '@/hooks/use-products';

const NO_ROWS: Product[] = [];

type Translate = ReturnType<typeof useTranslations>;

function ProductRowActions({
  product,
  onEdit,
  onDelete,
  t,
  tCommon,
}: {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  t: Translate;
  tCommon: Translate;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{t('list.openMenu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PermissionGate permission="product:update">
          <DropdownMenuItem
            onClick={() => {
              onEdit(product);
            }}
          >
            <Pencil className="h-4 w-4" />
            {tCommon('edit')}
          </DropdownMenuItem>
        </PermissionGate>
        <PermissionGate permission="product:delete">
          <DropdownMenuItem
            onClick={() => {
              onDelete(product);
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
  onEdit: (product: Product) => void,
  onDelete: (product: Product) => void,
  t: Translate,
  tCommon: Translate,
): ColumnDef<Product>[] {
  return [
    {
      accessorKey: 'name',
      header: tCommon('name'),
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{row.original.name}</p>
          <p className="text-xs text-muted-foreground">{'/'}{row.original.slug}</p>
        </div>
      ),
    },
    {
      id: 'apis',
      header: t('list.columns.apis'),
      cell: ({ row }) =>
        row.original.apis.length === 0 ? (
          <span className="text-muted-foreground">{t('list.noApis')}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.original.apis.slice(0, 3).map((api) => (
              <Badge key={api.id} variant="outline">
                {api.name}
              </Badge>
            ))}
            {row.original.apis.length > 3 && (
              <Badge variant="outline">{t('list.moreApis', { count: row.original.apis.length - 3 })}</Badge>
            )}
          </div>
        ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <ProductRowActions product={row.original} onEdit={onEdit} onDelete={onDelete} t={t} tCommon={tCommon} />
      ),
    },
  ];
}

function ProductsView() {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = useProducts();

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

  const createButton = (
    <PermissionGate permission="product:create">
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
        title={t('list.title')}
        description={t('list.description')}
        actions={createButton}
      />

      <ProductFormSheet mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <ProductFormSheet
          mode="edit"
          product={editTarget}
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
        />
      )}
      <DeleteProductDialog
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

export default function ProductsPage() {
  return (
    <PagePermissionGate permission="product:read">
      <ProductsView />
    </PagePermissionGate>
  );
}
