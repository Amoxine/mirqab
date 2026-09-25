'use client';

import { useMemo, useState } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { CertificateUploadSheet } from '@/components/certificates/certificate-upload-sheet';
import { DeleteCertificateDialog } from '@/components/certificates/delete-certificate-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { useCertificates, type Certificate } from '@/hooks/use-certificates';
import { FormattedDate } from '@/components/shared/formatted';

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
              <KeyRound className="h-3 w-3" />
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
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          <FormattedDate value={row.original.notBefore} />
          {' – '}
          <FormattedDate value={row.original.notAfter} />
        </span>
      ),
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

  const createButton = (
    <PermissionGate permission="cert:create">
      <Button
        onClick={() => {
          setUploadOpen(true);
        }}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('list.uploadButton')}
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
        emptyAction={createButton}
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
