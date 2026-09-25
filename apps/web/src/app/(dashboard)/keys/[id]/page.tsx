'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, Ban, Pencil, RotateCw, SearchX, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { DeleteKeyDialog } from '@/components/keys/delete-key-dialog';
import { KeyCreatedDialog } from '@/components/keys/key-created-dialog';
import { KeyFormSheet } from '@/components/keys/key-form-sheet';
import { KeyUsageCard } from '@/components/keys/key-usage-card';
import { QUOTA_PERIODS, formatQuotaPeriod, formatRate, keyStatusVariant, toDate } from '@/components/keys/key-utils';
import { RevokeKeyDialog } from '@/components/keys/revoke-key-dialog';
import { RotateKeyDialog } from '@/components/keys/rotate-key-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
import { useKey } from '@/hooks/use-keys';
import { ApiRequestError } from '@/lib/api-client';
import { FormattedDateTime, FormattedNumber } from '@/components/shared/formatted';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" data-testid="key-detail-loading" aria-busy="true">
      <Skeleton className="h-9 w-64 max-w-full" />
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
  const router = useRouter();
  const { data: key, isLoading, isError, error, refetch, isFetching } = useKey(id);
  const [editOpen, setEditOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  if (isLoading) return <DetailSkeleton />;

  if (isError || !key) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <StateCard
        role={notFound ? undefined : 'alert'}
        icon={notFound ? <SearchX aria-hidden="true" /> : <AlertTriangle className="text-destructive" aria-hidden="true" />}
        title={notFound ? t('detail.notFound') : t('detail.loadFailed')}
        message={notFound ? null : error instanceof Error ? error.message : t('detail.unexpectedError')}
      >
        {!notFound && (
          <Button onClick={() => void refetch()} disabled={isFetching}>
            {tCommon('retry')}
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href="/keys">{t('detail.backToKeys')}</Link>
        </Button>
      </StateCard>
    );
  }

  const isRevoked = key.status === 'REVOKED';
  // Matches KeyService.remove()'s own gate: any non-ACTIVE key can be deleted, not just revoked ones.
  const canDelete = key.status !== 'ACTIVE';
  const { tyk } = key;
  const renewsAt = toDate(tyk?.quotaRenewsAt);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/keys', label: t('detail.backToKeys') }}
        title={key.name}
        badges={<Badge variant={keyStatusVariant(key.status)}>{t(`status.${key.status}`)}</Badge>}
        description={t('detail.description')}
        actions={
          <>
            {!isRevoked && (
              <>
                <PermissionGate permission="key:update">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditOpen(true);
                    }}
                    disabled={tyk === null}
                    title={tyk === null ? t('detail.editDisabledHint') : undefined}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    {tCommon('edit')}
                  </Button>
                </PermissionGate>
                <PermissionGate permission="key:update">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRotateTarget({ id: key.id, name: key.name });
                    }}
                  >
                    <RotateCw className="h-4 w-4" aria-hidden="true" />
                    {t('actions.rotate')}
                  </Button>
                </PermissionGate>
                <PermissionGate permission="key:revoke">
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setRevokeTarget({ id: key.id, name: key.name });
                    }}
                  >
                    <Ban className="h-4 w-4" aria-hidden="true" />
                    {t('actions.revoke')}
                  </Button>
                </PermissionGate>
              </>
            )}
            {canDelete && (
              <PermissionGate permission="key:revoke">
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget({ id: key.id, name: key.name });
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('actions.delete')}
                </Button>
              </PermissionGate>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.detailsCard.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('detail.detailsCard.api')}>
                {key.apiDefId ? (
                  <Link href={`/apis/${key.apiDefId}`} className="rounded-sm font-medium text-primary hover:underline">
                    {key.apiDefName ?? key.apiDefId}
                  </Link>
                ) : (
                  '—'
                )}
              </Field>
              <Field label={tCommon('status')}>{t(`status.${key.status}`)}</Field>
              <Field label={t('form.planLabel')}>{key.planName ?? t('form.noPlan')}</Field>
              <Field label={t('detail.detailsCard.created')}><FormattedDateTime value={key.createdAt} /></Field>
              <Field label={t('detail.detailsCard.expires')}>
                {key.expiresAt ? <FormattedDateTime value={key.expiresAt} /> : t('list.never')}
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
                  {tyk.quotaMax > 0 ? <FormattedNumber value={tyk.quotaMax} /> : t('detail.limitsCard.noQuota')}
                </Field>
                {tyk.quotaMax > 0 && (
                  <>
                    <Field label={t('detail.limitsCard.quotaRemaining')}>
                      <FormattedNumber value={tyk.quotaRemaining} />
                    </Field>
                    <Field label={t('detail.limitsCard.quotaPeriod')}>
                      {formatQuotaPeriod(tyk.quotaRenewalRate, periodLabels, t('form.everyNSeconds'))}
                    </Field>
                    <Field label={t('detail.limitsCard.quotaRenews')}>
                      {renewsAt ? <FormattedDateTime value={renewsAt} /> : '—'}
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
      <RotateKeyDialog
        target={rotateTarget}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        onRotated={setRotatedKey}
      />
      <KeyCreatedDialog
        keyValue={rotatedKey}
        onClose={() => {
          setRotatedKey(null);
        }}
      />
      <DeleteKeyDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={() => {
          router.push('/keys');
        }}
      />
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
