'use client';

import { Notice } from '@open-gateway/ui';
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Pencil, Power, SearchX, Trash2 } from 'lucide-react';
import { ApiConfigCard } from '@/components/apis/api-config-card';
import { ApiFormSheet } from '@/components/apis/api-form-sheet';
import { ApiStatusBadge } from '@/components/apis/api-status-badge';
import { ClientsTab } from '@/components/apis/clients-tab';
import { DeleteApiDialog } from '@/components/apis/delete-api-dialog';
import { DesignerTab } from '@/components/apis/designer/designer-tab';
import { EndpointsTab } from '@/components/apis/endpoints/endpoints-tab';
import { SpecUpdateBanner } from '@/components/apis/spec-source/spec-update-banner';
import { SyncStatusBadge } from '@/components/apis/sync-status-badge';
import { TrafficTab } from '@/components/apis/traffic-tab';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/shared/data-table';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
import { toast } from '@/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApiDetail, useApiKeys, useSetApiStatus, type ApiDetail, type ApiKeySummary } from '@/hooks/use-apis';
import { usePermissions } from '@/hooks/use-permissions';
import { ApiRequestError } from '@/lib/api-client';
import type { ApiKeyStatus } from '@/types';
import { FormattedDate, FormattedDateTime } from '@/components/shared/formatted';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';

const KEY_VARIANT: Record<ApiKeyStatus, 'default' | 'secondary' | 'destructive'> = {
  ACTIVE: 'default',
  REVOKED: 'destructive',
  EXPIRED: 'secondary',
};

const formatDate = (value: string | null) => (value ? <FormattedDateTime value={value} /> : '—');

/** Tabs a link may open directly (`?tab=`), e.g. the import wizard landing on `endpoints`. */
const LINKABLE_TABS = ['overview', 'configuration', 'designer', 'endpoints'];

const isNotFound = (error: unknown) => error instanceof ApiRequestError && error.status === 404;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-10 w-72 max-w-full" />
      <Card>
        <CardContent className="grid gap-6 pt-6 sm:grid-cols-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-48 max-w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const NO_KEYS: ApiKeySummary[] = [];

function KeysTab({ apiId }: { apiId: string }) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const { data, isLoading, isError, error, refetch } = useApiKeys(apiId);

  const columns = useMemo<ColumnDef<ApiKeySummary>[]>(() => {
    const keyStatusLabel: Record<ApiKeyStatus, string> = {
      ACTIVE: t('keyStatus.active'),
      REVOKED: t('keyStatus.revoked'),
      EXPIRED: t('keyStatus.expired'),
    };
    return [
      {
        accessorKey: 'name',
        header: tCommon('name'),
        cell: ({ row }) => (
          <Link href={`/keys/${row.original.id}`} className="rounded-sm font-medium hover:underline">
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: 'status',
        header: tCommon('status'),
        cell: ({ row }) => <Badge variant={KEY_VARIANT[row.original.status]}>{keyStatusLabel[row.original.status]}</Badge>,
      },
      {
        accessorKey: 'expiresAt',
        header: t('keysTab.expires'),
        cell: ({ row }) =>
          row.original.expiresAt ? <FormattedDate value={row.original.expiresAt} /> : t('keysTab.never'),
      },
      {
        accessorKey: 'createdAt',
        header: tCommon('createdAt'),
        cell: ({ row }) => <FormattedDate value={row.original.createdAt} />,
      },
    ];
  }, [t, tCommon]);

  const table = useReactTable({ data: data?.data ?? NO_KEYS, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="space-y-2">
      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={t('keysTab.empty')}
        skeletonRows={3}
      />
      {data && data.meta.totalCount > data.data.length && (
        <p className="text-sm text-muted-foreground">
          {t('keysTab.showingCount', { shown: data.data.length, total: data.meta.totalCount })}
        </p>
      )}
    </div>
  );
}

function ApiDetailView({ apiDef }: { apiDef: ApiDetail }) {
  const router = useRouter();
  const { can } = usePermissions();
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const tOpenapi = useTranslations('openapi');
  const requestedTab = useSearchParams().get('tab') ?? '';
  const statusMutation = useSetApiStatus();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiDetail | null>(null);
  const [tab, setTab] = useState(LINKABLE_TABS.includes(requestedTab) ? requestedTab : 'overview');
  const isOAuth = apiDef.authType === 'OAUTH';

  const handleToggleStatus = async () => {
    const next = apiDef.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      const saved = await statusMutation.mutateAsync({ id: apiDef.id, status: next });
      toastSyncOutcome(t, saved, next === 'ACTIVE' ? t('actions.activatedToast') : t('actions.disabledToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('actions.statusErrorToast'));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/apis', label: t('backToList') }}
        title={apiDef.name}
        badges={<ApiStatusBadge status={apiDef.status} />}
        description={<span className="break-all font-mono text-sm">{apiDef.listenPath}</span>}
        actions={
          <>
            <PermissionGate permission="api:update">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                {tCommon('edit')}
              </Button>
              <Button
                type="button"
                variant="outline"
                loading={statusMutation.isPending}
                onClick={() => {
                  void handleToggleStatus();
                }}
              >
                <Power className="h-4 w-4" aria-hidden="true" />
                {apiDef.status === 'ACTIVE' ? t('actions.disable') : t('actions.activate')}
              </Button>
            </PermissionGate>
            <PermissionGate permission="api:delete">
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  setDeleteTarget(apiDef);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {tCommon('delete')}
              </Button>
            </PermissionGate>
          </>
        }
      />

      {/* The Endpoints tab shows the same banner with the source card; not twice. */}
      {tab !== 'endpoints' && <SpecUpdateBanner apiId={apiDef.id} />}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
          <TabsTrigger value="configuration">{t('tabs.configuration')}</TabsTrigger>
          <TabsTrigger value="designer">{t('tabs.designer')}</TabsTrigger>
          <TabsTrigger value="endpoints">{tOpenapi('tab')}</TabsTrigger>
          {/* An OAUTH api authenticates JWTs, so a Tyk auth-token key could never work on it. */}
          {can('key:read') && !isOAuth && <TabsTrigger value="keys">{t('tabs.keys')}</TabsTrigger>}
          {can('key:read') && isOAuth && <TabsTrigger value="clients">{t('tabs.clients')}</TabsTrigger>}
          {/* V1-LOG-02: reads back `detailedRecording` capture, same gate as the toggle that turns it on. */}
          {can('api:update') && <TabsTrigger value="traffic">{t('tabs.traffic')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('tabs.overview')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {apiDef.syncStatus === 'FAILED' && (
                <Notice tone="destructive" role="alert">
                    {t('overview.syncAlert', { error: apiDef.syncError ?? t('unknownGatewayError') })}
                  </Notice>
              )}
              <dl className="grid gap-6 sm:grid-cols-2">
                <Field label={tCommon('name')}>{apiDef.name}</Field>
                <Field label={t('field.slug')}>
                  <span className="font-mono">{apiDef.slug}</span>
                </Field>
                <Field label={t('field.listenPath')}>
                  <span className="break-all font-mono">{apiDef.listenPath}</span>
                </Field>
                <Field label={t('field.upstreamUrl')}>
                  <span className="break-all font-mono">{apiDef.proxyUrl}</span>
                </Field>
                <Field label={t('field.authType')}>{apiDef.authType}</Field>
                <Field label={tCommon('status')}>
                  <ApiStatusBadge status={apiDef.status} />
                </Field>
                <Field label={t('field.gatewayApiId')}>
                  {apiDef.tykApiId ? (
                    <span className="break-all font-mono">{apiDef.tykApiId}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('overview.notSyncedYet')}</span>
                  )}
                </Field>
                <Field label={t('field.syncStatus')}>
                  <SyncStatusBadge apiId={apiDef.id} syncStatus={apiDef.syncStatus} syncError={apiDef.syncError} />
                </Field>
                <Field label={t('field.lastSynced')}>{formatDate(apiDef.lastSyncedAt)}</Field>
                {!isOAuth && <Field label={t('tabs.keys')}>{apiDef.keyCount}</Field>}
                <Field label={tCommon('createdAt')}>{formatDate(apiDef.createdAt)}</Field>
                <Field label={t('field.updated')}>{formatDate(apiDef.updatedAt)}</Field>
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="configuration" className="mt-4">
          <ApiConfigCard
            config={apiDef.config}
            onEdit={
              can('api:update')
                ? () => {
                    setEditOpen(true);
                  }
                : undefined
            }
          />
        </TabsContent>

        <TabsContent value="designer" className="mt-4">
          <DesignerTab api={apiDef} />
        </TabsContent>

        <TabsContent value="endpoints" className="mt-4">
          <EndpointsTab api={apiDef} />
        </TabsContent>

        {can('key:read') && !isOAuth && (
          <TabsContent value="keys" className="mt-4">
            <KeysTab apiId={apiDef.id} />
          </TabsContent>
        )}

        {can('key:read') && isOAuth && (
          <TabsContent value="clients" className="mt-4">
            <ClientsTab apiId={apiDef.id} />
          </TabsContent>
        )}

        {can('api:update') && (
          <TabsContent value="traffic" className="mt-4">
            <TrafficTab apiId={apiDef.id} />
          </TabsContent>
        )}
      </Tabs>

      <ApiFormSheet mode="edit" api={apiDef} open={editOpen} onOpenChange={setEditOpen} />
      <DeleteApiDialog
        api={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
        }}
        onDeleted={() => {
          router.push('/apis');
        }}
      />
    </div>
  );
}

function ApiDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const { data, isPending, isError, error, refetch } = useApiDetail(id);

  if (isPending) return <DetailSkeleton />;

  if (isError) {
    if (isNotFound(error)) {
      return (
        <StateCard
          icon={<SearchX aria-hidden="true" />}
          title={t('notFound.title')}
          message={t('notFound.message')}
        >
          <Button asChild>
            <Link href="/apis">{t('backToList')}</Link>
          </Button>
        </StateCard>
      );
    }
    return (
      <StateCard
        role="alert"
        icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
        title={t('loadError.title')}
        message={error.message}
      >
        <Button
          type="button"
          onClick={() => {
            void refetch();
          }}
        >
          {tCommon('retry')}
        </Button>
        <Button asChild variant="outline">
          <Link href="/apis">{t('backToList')}</Link>
        </Button>
      </StateCard>
    );
  }

  return <ApiDetailView apiDef={data} />;
}

export default function ApiDetailPageGated() {
  return (
    <PagePermissionGate permission="api:read">
      <ApiDetailPage />
    </PagePermissionGate>
  );
}
