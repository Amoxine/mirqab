'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useKeyUsage } from '@/hooks/use-keys';
import type { AnalyticsRange } from '@/types';
import { quotaUsedPercent, toDate } from './key-utils';

const RANGES: AnalyticsRange[] = ['1h', '24h', '7d', '30d'];

interface KeyUsageCardProps {
  keyId: string;
  /** `false` when the key's live gateway limits could not be read (`KeyDetail.tyk === null`). */
  gatewayReachable: boolean;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** Quota progress from the gateway plus range-scoped traffic for one key. */
export function KeyUsageCard({ keyId, gatewayReachable }: KeyUsageCardProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const { data: usage, isLoading, isError, error, refetch, isFetching } = useKeyUsage(keyId, range);

  const percent = usage ? quotaUsedPercent(usage.quotaMax, usage.quotaRemaining) : null;
  const resetAt = usage ? toDate(usage.quotaResetAt) : null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t('usage.title')}</CardTitle>
          <CardDescription>{t('usage.description')}</CardDescription>
        </div>
        <Select value={range} onValueChange={(v) => {
            setRange(v as AnalyticsRange);
          }}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t('usage.rangeLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`usage.ranges.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          </div>
        ) : isError || !usage ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/50 p-4">
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : t('usage.loadFailed')}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              {tCommon('retry')}
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-2" data-testid="quota-section">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{t('usage.quota')}</span>
                {percent !== null && usage.quotaMax !== null && usage.quotaRemaining !== null && (
                  <span className="tabular-nums text-muted-foreground">
                    {t('usage.quotaUsed', {
                      used: (usage.quotaMax - usage.quotaRemaining).toLocaleString(),
                      max: usage.quotaMax.toLocaleString(),
                    })}
                  </span>
                )}
              </div>
              {percent !== null ? (
                <>
                  <div
                    role="progressbar"
                    aria-label={t('usage.quotaUsedAria')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(percent)}
                    className="h-2 w-full overflow-hidden rounded-full bg-secondary"
                  >
                    <div
                      className={`h-full rounded-full transition-all ${
                        percent >= 90 ? 'bg-destructive' : 'bg-primary'
                      }`}
                      style={{ width: `${String(percent)}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('usage.quotaRemaining', { remaining: usage.quotaRemaining?.toLocaleString() ?? '' })}
                    {resetAt ? t('usage.quotaResets', { date: resetAt.toLocaleString() }) : ''}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {gatewayReachable ? t('usage.noQuota') : t('detail.gatewayUnreachable')}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label={t('usage.stats.requests')} value={usage.requests.toLocaleString()} />
              <Stat label={t('usage.stats.errors')} value={usage.errors.toLocaleString()} />
              <Stat label={t('usage.stats.errorRate')} value={`${usage.errorRate.toFixed(1)}%`} />
              <Stat
                label={t('usage.stats.avgLatencyLabel')}
                value={t('usage.stats.avgLatency', { value: String(Math.round(usage.avgLatencyMs)) })}
              />
            </div>
            {usage.requests === 0 && <p className="text-sm text-muted-foreground">{t('usage.noTraffic')}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
