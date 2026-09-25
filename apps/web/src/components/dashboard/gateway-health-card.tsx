'use client';

import { useTranslations } from 'next-intl';
import { Server } from 'lucide-react';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useGatewayStatus } from '@/hooks/use-gateway-status';
import type { GatewayStatus } from '@/types';
import { useFormat } from '@/hooks/use-format';

function Row({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums" dir={ltr ? 'ltr' : undefined}>
        {value}
      </dd>
    </div>
  );
}

export function GatewayHealthCard() {
  const { data, isLoading, error, refetch } = useGatewayStatus();
  const gateway = data?.gateway;
  const t = useTranslations('dashboard.gatewayHealth');
  const fmt = useFormat();

  const redisLabel: Record<GatewayStatus['gateway']['redis'], string> = {
    pass: t('redisStatus.pass'),
    fail: t('redisStatus.fail'),
    unknown: t('redisStatus.unknown'),
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <Server className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : error || !gateway ? (
          <AnalyticsErrorState message={error?.message ?? t('noStatus')} onRetry={() => void refetch()} />
        ) : (
          <div className="space-y-4">
            {gateway.reachable ? (
              <Badge variant="success">{t('reachable')}</Badge>
            ) : (
              <Badge variant="destructive">{t('unreachable')}</Badge>
            )}
            {!gateway.reachable && gateway.error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {gateway.error}
              </p>
            )}
            <dl className="space-y-2">
              <Row label={t('version')} value={gateway.version ?? '—'} ltr />
              <Row label={t('redis')} value={gateway.reachable ? redisLabel[gateway.redis] : '—'} />
              <Row label={t('latency')} value={gateway.latencyMs === null ? '—' : fmt.ms(gateway.latencyMs)} />
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
