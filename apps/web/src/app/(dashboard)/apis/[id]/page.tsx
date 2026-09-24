'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Pencil, Power, SearchX, Trash2 } from 'lucide-react';
import { ApiConfigCard } from '@/components/apis/api-config-card';
import { ApiFormSheet } from '@/components/apis/api-form-sheet';
import { ApiStatusBadge } from '@/components/apis/api-status-badge';
import { ClientsTab } from '@/components/apis/clients-tab';
import { DeleteApiDialog } from '@/components/apis/delete-api-dialog';
import { DesignerTab } from '@/components/apis/designer/designer-tab';
import { SyncStatusBadge } from '@/components/apis/sync-status-badge';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApiDetail, useApiKeys, useSetApiStatus, type ApiDetail } from '@/hooks/use-apis';
import { usePermissions } from '@/hooks/use-permissions';
import { ApiRequestError } from '@/lib/api-client';
import type { ApiKeyStatus } from '@/types';

const KEY_VARIANT: Record<ApiKeyStatus, 'default' | 'secondary' | 'destructive'> = {
  ACTIVE: 'default',
  REVOKED: 'destructive',
  EXPIRED: 'secondary',
};

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

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

function StateCard({ icon, title, message, children }: { icon: ReactNode; title: string; message: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        {icon}
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-md break-words text-sm text-muted-foreground">{message}</p>
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      </CardContent>
    </Card>
  );
}

function KeysTab({ apiId }: { apiId: string }) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const { data, isLoading, isError, error, refetch } = useApiKeys(apiId);
  const keyStatusLabel: Record<ApiKeyStatus, string> = {
    ACTIVE: t('keyStatus.active'),
    REVOKED: t('keyStatus.revoked'),
    EXPIRED: t('keyStatus.expired'),
  };

  let body: ReactNode;
  if (isLoading) {
    body = Array.from({ length: 3 }).map((_, i) => (
      <TableRow key={i}>
        {Array.from({ length: 4 }).map((__, j) => (
          <TableCell key={j}>
            <Skeleton className="h-5 w-24" />
          </TableCell>
        ))}
      </TableRow>
    ));
  } else if (isError) {
    body = (
      <TableRow>
        <TableCell colSpan={4} className="h-24 text-center">
          <p className="text-sm text-destructive">{error.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void refetch();
            }}
          >
            {tCommon('retry')}
          </Button>
        </TableCell>
      </TableRow>
    );
  } else if (!data?.data.length) {
    body = (
      <TableRow>
        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
          {t('keysTab.empty')}
        </TableCell>
      </TableRow>
    );
  } else {
    body = data.data.map((key) => (
      <TableRow key={key.id}>
        <TableCell>
          <Link href={`/keys/${key.id}`} className="font-medium hover:underline">
            {key.name}
          </Link>
        </TableCell>
        <TableCell>
          <Badge variant={KEY_VARIANT[key.status]}>{keyStatusLabel[key.status]}</Badge>
        </TableCell>
        <TableCell>{key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : t('keysTab.never')}</TableCell>
        <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
      </TableRow>
    ));
  }

  return (
    <div className="space-y-2">
      {/* w-0 + min-w-full keeps the table's width out of the page layout, so it scrolls inside its own box. */}
      <div className="w-0 min-w-full rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tCommon('name')}</TableHead>
              <TableHead>{tCommon('status')}</TableHead>
              <TableHead>{t('keysTab.expires')}</TableHead>
              <TableHead>{tCommon('createdAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{body}</TableBody>
        </Table>
      </div>
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
  const statusMutation = useSetApiStatus();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiDetail | null>(null);
  const isOAuth = apiDef.authType === 'OAUTH';

  const handleToggleStatus = async () => {
    const next = apiDef.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      await statusMutation.mutateAsync({ id: apiDef.id, status: next });
      toast.success(next === 'ACTIVE' ? t('actions.activatedToast') : t('actions.disabledToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('actions.statusErrorToast'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ms-3">
          <Link href="/apis">
            <ArrowLeft className="me-2 h-4 w-4" />
            {t('backToList')}
          </Link>
        </Button>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words text-3xl font-bold tracking-tight">{apiDef.name}</h1>
              <ApiStatusBadge status={apiDef.status} />
            </div>
            <p className="mt-1 break-all font-mono text-sm text-muted-foreground">{apiDef.listenPath}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PermissionGate permission="api:update">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditOpen(true);
                }}
              >
                <Pencil className="me-2 h-4 w-4" />
                {tCommon('edit')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={statusMutation.isPending}
                onClick={() => {
                  void handleToggleStatus();
                }}
              >
                <Power className="me-2 h-4 w-4" />
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
                <Trash2 className="me-2 h-4 w-4" />
                {tCommon('delete')}
              </Button>
            </PermissionGate>
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
          <TabsTrigger value="configuration">{t('tabs.configuration')}</TabsTrigger>
          <TabsTrigger value="designer">{t('tabs.designer')}</TabsTrigger>
          {/* An OAUTH api authenticates JWTs, so a Tyk auth-token key could never work on it. */}
          {can('key:read') && !isOAuth && <TabsTrigger value="keys">{t('tabs.keys')}</TabsTrigger>}
          {can('key:read') && isOAuth && <TabsTrigger value="clients">{t('tabs.clients')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('tabs.overview')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {apiDef.syncStatus === 'FAILED' && (
                <div
                  role="alert"
                  className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p className="min-w-0 break-words">
                    {t('overview.syncAlert', { error: apiDef.syncError ?? t('unknownGatewayError') })}
                  </p>
                </div>
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
          icon={<SearchX className="h-10 w-10 text-muted-foreground" />}
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
        icon={<AlertTriangle className="h-10 w-10 text-destructive" />}
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
