'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { useGatewayStatus, useRetrySync } from '@/hooks/use-gateway-status';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';
import type { Locale } from '@/i18n/locales';

function Count({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-2xl font-bold', className)}>{value.toLocaleString()}</dd>
    </div>
  );
}

export function SyncSummaryCard() {
  const { data, isLoading, error, refetch } = useGatewayStatus();
  const retry = useRetrySync();
  const t = useTranslations('dashboard.syncSummary');
  const tCommon = useTranslations('common');
  const locale = dateFnsLocale(useLocale() as Locale);

  const handleRetry = (id: string, name: string) => {
    retry.mutate(id, {
      onSuccess: (result) => {
        // Always HTTP 200: a failed sync is reported in the body.
        if (result.syncStatus === 'SYNCED') toast.success(t('syncedToast', { name }));
        else toast.error(result.syncError ?? t('syncFailedToast', { name }));
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : error || !data ? (
          <AnalyticsErrorState message={error?.message ?? t('noStatus')} onRetry={() => void refetch()} />
        ) : data.apis.total === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">{t('emptyTitle')}</p>
            <PermissionGate permission="api:create">
              <Button asChild size="sm">
                <Link href="/apis">{t('createApi')}</Link>
              </Button>
            </PermissionGate>
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Count label={t('total')} value={data.apis.total} />
              <Count label={t('synced')} value={data.apis.synced} className="text-success" />
              <Count label={t('pending')} value={data.apis.pending} className="text-warning" />
              <Count label={t('failed')} value={data.apis.failed} className={data.apis.failed > 0 ? 'text-destructive' : ''} />
            </dl>
            {data.failedSyncs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noFailedSyncs')}</p>
            ) : (
              <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
                {data.failedSyncs.map((failed) => (
                  <li key={failed.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <Link href={`/apis/${failed.id}`} className="text-sm font-medium hover:underline">
                        {failed.name}
                      </Link>
                      <p className="truncate text-xs text-destructive" title={failed.syncError ?? undefined}>
                        {failed.syncError ?? t('syncFailed')}
                      </p>
                      {failed.lastSyncedAt && (
                        <p className="text-xs text-muted-foreground">
                          {t('lastSync', {
                            time: formatDistanceToNow(new Date(failed.lastSyncedAt), { addSuffix: true, locale }),
                          })}
                        </p>
                      )}
                    </div>
                    <PermissionGate permission="api:sync">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retry.isPending}
                        onClick={() => {
                          handleRetry(failed.id, failed.name);
                        }}
                      >
                        {retry.isPending && retry.variables === failed.id ? t('retrying') : tCommon('retry')}
                      </Button>
                    </PermissionGate>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
