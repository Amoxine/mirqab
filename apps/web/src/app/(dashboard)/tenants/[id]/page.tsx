'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, Pencil, Play, SearchX, ShieldOff, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
import { MembersCard } from '@/components/tenants/members-card';
import { TenantFormSheet } from '@/components/tenants/tenant-form-sheet';
import { TenantStatusDialog } from '@/components/tenants/tenant-status-dialog';
import { TenantUsageCard } from '@/components/tenants/tenant-usage-card';
import { useTenant, type Tenant } from '@/hooks/use-tenants';
import { usePermissions } from '@/hooks/use-permissions';
import { ApiRequestError } from '@/lib/api-client';
import { FormattedDateTime } from '@/components/shared/formatted';

const tenantStatusColor = (status: string) =>
  status === 'ACTIVE' ? 'default' : status === 'SUSPENDED' ? 'destructive' : 'outline';

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
      <Card>
        <CardContent className="grid gap-6 pt-6 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
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

function TenantDetailView({ tenant }: { tenant: Tenant }) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const { can } = usePermissions();
  const [editOpen, setEditOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<'suspend' | 'reactivate' | 'archive' | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/tenants', label: t('detail.backToTenants') }}
        title={tenant.name}
        badges={
          <>
            <Badge variant={tenantStatusColor(tenant.status)}>{t(`status.${tenant.status}`)}</Badge>
            <Badge variant="outline">{t(`plan.${tenant.plan}`)}</Badge>
          </>
        }
        description={<span className="font-mono text-sm">{'/'}{tenant.slug}</span>}
        actions={
          tenant.status !== 'ARCHIVED' && (
            <>
              <PermissionGate permission="tenant:update">
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
                  onClick={() => {
                    setStatusAction(tenant.status === 'SUSPENDED' ? 'reactivate' : 'suspend');
                  }}
                >
                  {tenant.status === 'SUSPENDED' ? (
                    <Play className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ShieldOff className="h-4 w-4" aria-hidden="true" />
                  )}
                  {tenant.status === 'SUSPENDED' ? t('actions.reactivate') : t('actions.suspend')}
                </Button>
              </PermissionGate>
              <PermissionGate permission="tenant:delete">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setStatusAction('archive');
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('actions.archive')}
                </Button>
              </PermissionGate>
            </>
          )
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('detail.overview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-6 sm:grid-cols-2">
            <Field label={tCommon('name')}>{tenant.name}</Field>
            <Field label={t('fields.slug')}>
              <span className="font-mono">{tenant.slug}</span>
            </Field>
            <Field label={t('fields.plan')}>{t(`plan.${tenant.plan}`)}</Field>
            <Field label={tCommon('status')}>
              <Badge variant={tenantStatusColor(tenant.status)}>{t(`status.${tenant.status}`)}</Badge>
            </Field>
            <Field label={tCommon('createdAt')}>
              <FormattedDateTime value={tenant.createdAt} />
            </Field>
            <Field label={t('fields.updated')}>
              <FormattedDateTime value={tenant.updatedAt} />
            </Field>
          </dl>
        </CardContent>
      </Card>

      <PermissionGate permission="user:read">
        {/* `key`: force a remount on tenant switch — otherwise `keepPreviousData` (members-card.tsx)
         * would carry the previous tenant's rows/search/page state into the new tenant's first render. */}
        <MembersCard key={tenant.id} tenantId={tenant.id} />
      </PermissionGate>

      <TenantUsageCard tenantId={tenant.id} tenantName={tenant.name} canManage={can('tenant:update')} />

      <TenantFormSheet mode="edit" tenant={tenant} open={editOpen} onOpenChange={setEditOpen} />
      <TenantStatusDialog
        tenant={statusAction ? { id: tenant.id, name: tenant.name } : null}
        action={statusAction ?? 'suspend'}
        onClose={() => {
          setStatusAction(null);
        }}
        onArchived={() => {
          router.push('/tenants');
        }}
      />
    </div>
  );
}

function TenantDetailPage() {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const { id } = useParams<{ id: string }>();
  const { data, isPending, isError, error, refetch } = useTenant(id);

  if (isPending) return <DetailSkeleton />;

  if (isError) {
    if (isNotFound(error)) {
      return (
        <StateCard
          icon={<SearchX aria-hidden="true" />}
          title={t('detail.notFoundTitle')}
          message={t('detail.notFoundMessage')}
        >
          <Button asChild>
            <Link href="/tenants">{t('detail.backToTenants')}</Link>
          </Button>
        </StateCard>
      );
    }
    return (
      <StateCard
        role="alert"
        icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
        title={t('detail.loadErrorTitle')}
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
          <Link href="/tenants">{t('detail.backToTenants')}</Link>
        </Button>
      </StateCard>
    );
  }

  return <TenantDetailView tenant={data} />;
}

export default function TenantDetailPageGated() {
  return (
    <PagePermissionGate permission="tenant:read">
      <TenantDetailPage />
    </PagePermissionGate>
  );
}
