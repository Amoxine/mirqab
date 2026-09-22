'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Ban, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { KeyFormSheet } from '@/components/keys/key-form-sheet';
import { KeyUsageCard } from '@/components/keys/key-usage-card';
import { QUOTA_PERIODS, formatQuotaPeriod, formatRate, keyStatusVariant, toDate } from '@/components/keys/key-utils';
import { RevokeKeyDialog } from '@/components/keys/revoke-key-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useKey } from '@/hooks/use-keys';
import { ApiRequestError } from '@/lib/api-client';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function BackLink() {
  const t = useTranslations('keys');
  return (
    <Link
      href="/keys"
      className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="me-1 h-4 w-4" />
      {t('detail.backToKeys')}
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" data-testid="key-detail-loading">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function KeyDetailPage() {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const periodLabels = Object.fromEntries(QUOTA_PERIODS.map((p) => [p, t(`form.quotaPeriods.${p}`)])) as Record<
    (typeof QUOTA_PERIODS)[number],
    string
  >;
  const { id } = useParams<{ id: string }>();
  const { data: key, isLoading, isError, error, refetch, isFetching } = useKey(id);
  const [editOpen, setEditOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  if (isLoading) return <DetailSkeleton />;

  if (isError || !key) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="flex flex-col items-center gap-3 rounded-md border p-10 text-center">
          <h1 className="text-xl font-semibold">
            {notFound ? t('detail.notFound') : t('detail.loadFailed')}
          </h1>
          {!notFound && (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : t('detail.unexpectedError')}
            </p>
          )}
          {notFound ? (
            <Button asChild variant="outline">
              <Link href="/keys">{t('detail.backToKeys')}</Link>
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              {tCommon('retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const isRevoked = key.status === 'REVOKED';
  const { tyk } = key;
  const renewsAt = toDate(tyk?.quotaRenewsAt);

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-3xl font-bold tracking-tight">{key.name}</h1>
            <Badge variant={keyStatusVariant(key.status)}>{t(`status.${key.status}`)}</Badge>
          </div>
          <p className="mt-1 text-muted-foreground">{t('detail.description')}</p>
        </div>
        {!isRevoked && (
          <div className="flex flex-wrap gap-2">
            <PermissionGate permission="key:update">
              <Button
                variant="outline"
                onClick={() => {
                  setEditOpen(true);
                }}
                disabled={tyk === null}
                title={tyk === null ? t('detail.editDisabledHint') : undefined}
              >
                <Pencil className="me-2 h-4 w-4" />
                {tCommon('edit')}
              </Button>
            </PermissionGate>
            <PermissionGate permission="key:revoke">
              <Button variant="destructive" onClick={() => {
                  setRevokeTarget({ id: key.id, name: key.name });
                }}>
                <Ban className="me-2 h-4 w-4" />
                {t('actions.revoke')}
              </Button>
            </PermissionGate>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.detailsCard.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('detail.detailsCard.api')}>
                {key.apiDefId ? (
                  <Link href={`/apis/${key.apiDefId}`} className="text-primary hover:underline">
                    {key.apiDefName ?? key.apiDefId}
                  </Link>
                ) : (
                  '—'
                )}
              </Field>
              <Field label={tCommon('status')}>{t(`status.${key.status}`)}</Field>
              <Field label={t('detail.detailsCard.created')}>{new Date(key.createdAt).toLocaleString()}</Field>
              <Field label={t('detail.detailsCard.expires')}>
                {key.expiresAt ? new Date(key.expiresAt).toLocaleString() : t('list.never')}
              </Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.limitsCard.title')}</CardTitle>
            <CardDescription>{t('detail.limitsCard.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            {tyk ? (
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('detail.limitsCard.rateLimit')}>
                  {formatRate(tyk.rate, tyk.per, t('form.rateLimitPlaceholder'))}
                </Field>
                <Field label={t('detail.limitsCard.quota')}>
                  {tyk.quotaMax > 0 ? tyk.quotaMax.toLocaleString() : t('detail.limitsCard.noQuota')}
                </Field>
                {tyk.quotaMax > 0 && (
                  <>
                    <Field label={t('detail.limitsCard.quotaRemaining')}>
                      {tyk.quotaRemaining.toLocaleString()}
                    </Field>
                    <Field label={t('detail.limitsCard.quotaPeriod')}>
                      {formatQuotaPeriod(tyk.quotaRenewalRate, periodLabels, t('form.everyNSeconds'))}
                    </Field>
                    <Field label={t('detail.limitsCard.quotaRenews')}>
                      {renewsAt ? renewsAt.toLocaleString() : '—'}
                    </Field>
                  </>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="gateway-unreachable">
                {t('detail.gatewayUnreachable')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <KeyUsageCard keyId={key.id} gatewayReachable={tyk !== null} />

      <KeyFormSheet mode="edit" open={editOpen} onOpenChange={setEditOpen} keyData={key} />
      <RevokeKeyDialog target={revokeTarget} onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }} />
    </div>
  );
}

export default function KeyDetailPageGated() {
  return (
    <PagePermissionGate permission="key:read">
      <KeyDetailPage />
    </PagePermissionGate>
  );
}
