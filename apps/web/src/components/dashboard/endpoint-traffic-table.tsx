'use client';

import { Activity } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { StateMessage } from '@/components/shared/state-card';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsTraffic } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';
import { ScopeTag } from './scope-tag';

/** Error rate at or above this share of requests is flagged (text + colour), as in the per-API table. */
const ERROR_FLAG = 5;

/** The per-API table's counterpart once the dashboard is narrowed to one API: its busiest endpoints. */
export function EndpointTrafficTable({
  range,
  scope,
}: {
  range: AnalyticsRange;
  scope: { id: string; name: string };
}) {
  const t = useTranslations('dashboard.endpointTraffic');
  const tRanges = useTranslations('analytics.ranges');
  const locale = useLocale();
  const fmt = useFormat();
  const { data, isLoading, error, refetch } = useAnalyticsTraffic({ range, apiId: scope.id });
  const rows = data?.topEndpoints ?? [];
  const max = Math.max(...rows.map((row) => row.requests), 1);

  return (
    <Card variant="ink" className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
        <div>
          <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-normal tracking-tight">
            {t('title')}
            <ScopeTag name={scope.name} />
          </h2>
          <p className="text-muted-foreground mt-0.5 text-sm">{t('description')}</p>
        </div>
        <span className="text-muted-foreground rounded-full border px-2.5 py-0.5 font-mono text-[0.7rem]">
          {tRanges(range)}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-5 sm:px-6" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <AnalyticsErrorState message={error.message} onRetry={() => void refetch()} />
      ) : !rows.length ? (
        <StateMessage icon={<Activity aria-hidden="true" />} message={t('empty')} className="py-10" />
      ) : (
        <div className="overflow-x-auto px-3 pb-3 pt-2 sm:px-4">
          <table className="w-full min-w-[40rem] border-separate border-spacing-y-1 text-start">
            <thead>
              <tr className="text-muted-foreground font-mono text-[0.68rem] uppercase tracking-[0.08em]">
                <th scope="col" className="px-3 py-2 text-start font-normal">
                  {t('endpoint')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-normal">
                  {t('requests')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-normal">
                  {t('errorRate')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-normal">
                  {t('avgLatency')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-normal">
                  {t('p95')}
                </th>
              </tr>
            </thead>
            <tbody className="text-sm tabular-nums">
              {rows.map((row) => {
                const flagged = row.requests > 0 && row.errorRate >= ERROR_FLAG;
                return (
                  <tr
                    key={`${row.method} ${row.path}`}
                    className="hover:bg-accent transition-colors [&>td:first-child]:rounded-s-xl [&>td:last-child]:rounded-e-xl"
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <MethodBadge method={row.method} />
                        <span dir="ltr" className="truncate font-mono text-xs">
                          {row.path}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <span
                          className="bg-muted relative h-0.5 w-20 shrink-0 rounded-full"
                          aria-hidden="true"
                        >
                          <span
                            className="bg-primary absolute inset-y-0 start-0 rounded-full"
                            style={{ width: `${((row.requests / max) * 100).toFixed(1)}%` }}
                          />
                        </span>
                        <span title={fmt.number(row.requests)}>
                          {formatCount(row.requests, locale)}
                        </span>
                      </div>
                    </td>
                    <td className={cn('px-3 py-2.5 text-end', flagged && 'text-destructive')}>
                      {fmt.percent(row.errorRate)}
                      {flagged && <span className="sr-only"> {t('highErrorRate')}</span>}
                      {flagged && <span aria-hidden="true">{' ▲'}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-end">{fmt.ms(row.avgLatencyMs)}</td>
                    <td className="px-3 py-2.5 text-end">{fmt.ms(row.p95LatencyMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
