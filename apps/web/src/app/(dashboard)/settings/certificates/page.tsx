'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { CertificateUploadSheet } from '@/components/certificates/certificate-upload-sheet';
import { DeleteCertificateDialog } from '@/components/certificates/delete-certificate-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { useCertificates, type Certificate } from '@/hooks/use-certificates';

const NO_ROWS: Certificate[] = [];

type Translate = ReturnType<typeof useTranslations>;

function getColumns(
  onDelete: (cert: Certificate) => void,
  t: Translate,
  tCommon: Translate,
): ColumnDef<Certificate>[] {
  return [
    {
      accessorKey: 'commonName',
      header: t('list.columns.name'),
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{row.original.commonName ?? t('list.unnamed')}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.original.fingerprint.slice(0, 16)}{'…'}</p>
        </div>
      ),
    },
    {
      id: 'hasPrivate',
      header: t('list.columns.type'),
      cell: ({ row }) => (
        <Badge variant={row.original.hasPrivate ? 'default' : 'outline'}>
          {row.original.hasPrivate ? (
            <>
              <KeyRound className="me-1 h-3 w-3" />
              {t('list.clientCert')}
            </>
          ) : (
            t('list.caOnly')
          )}
        </Badge>
      ),
    },
    {
      id: 'validity',
      header: t('list.columns.validity'),
      cell: ({ row }) =>
        `${new Date(row.original.notBefore).toLocaleDateString()} – ${new Date(row.original.notAfter).toLocaleDateString()}`,
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <PermissionGate permission="cert:delete">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              onDelete(row.original);
            }}
          >
            <Trash2 className="h-4 w-4" />
            <span className="sr-only">{tCommon('delete')}</span>
          </Button>
        </PermissionGate>
      ),
    },
  ];
}

function CertificatesView() {
  const t = useTranslations('certificates');
  const tCommon = useTranslations('common');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = useCertificates();

  const columns = useMemo(
    () =>
      getColumns(
        (cert) => {
          setDeleteTarget({ id: cert.id, label: cert.commonName ?? cert.fingerprint });
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
      <div>
        <Button asChild variant="ghost" size="sm" className="-ms-3">
          <Link href="/settings">
            <ArrowLeft className="me-2 h-4 w-4" />
            {t('backToSettings')}
          </Link>
        </Button>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t('list.title')}</h1>
            <p className="mt-1 text-muted-foreground">{t('list.description')}</p>
          </div>
          <PermissionGate permission="cert:create">
            <Button
              onClick={() => {
                setUploadOpen(true);
              }}
            >
              <Plus className="me-2 h-4 w-4" />
              {t('list.uploadButton')}
            </Button>
          </PermissionGate>
        </div>
      </div>

      <CertificateUploadSheet open={uploadOpen} onOpenChange={setUploadOpen} />
      <DeleteCertificateDialog
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

export default function CertificatesPage() {
  return (
    <PagePermissionGate permission="cert:read">
      <CertificatesView />
    </PagePermissionGate>
  );
}
