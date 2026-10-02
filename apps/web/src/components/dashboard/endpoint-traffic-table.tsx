'use client';

import Link from 'next/link';
import { Activity } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { FIGURE_LINK, RowLink, rowLinkProps } from '@/components/shared/row-link';
import { StateMessage } from '@/components/shared/state-card';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsTraffic } from '@/hooks/use-analytics';
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { useFormat } from '@/hooks/use-format';
import { endpointTokens, searchHref, trafficHref } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';
import { ScopeTag } from './scope-tag';
import { ERROR_FLAG, FLAGGED_RATE } from './traffic-table';

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
  const canSearch = useCanSearchRequests();
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
        // `relative`: the sr-only texts in the rows are absolutely positioned, and without a positioned
        // scroller they sit outside its clip and widen the page.
        <div className="relative overflow-x-auto px-3 pb-3 pt-2 sm:px-4">
          <table className="w-full min-w-[28rem] border-separate border-spacing-y-1 text-start">
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
                // The row (a click follows its hidden link) and the path (the keyboard's link) open this
                // endpoint's traffic; its failures open the search for them (errors are status 400 and up).
                // Each link says which endpoint it is for in its own text: the method is a badge beside
                // the path, not part of the link, and a bare number names nothing.
                const traffic = trafficHref({
                  range,
                  apiId: scope.id,
                  method: row.method,
                  path: row.path,
                });
                // None for a path search cannot write: a link that dropped it would list other endpoints' failures.
                const tokens = endpointTokens(row, scope.id);
                const errorsHref = tokens ? searchHref([...tokens, 'status:>=400'], range) : undefined;
                const errorRate = fmt.percent(row.errorRate);
                return (
                  <tr
                    key={`${row.method} ${row.path}`}
                    {...rowLinkProps(
                      'hover:bg-accent transition-colors [&>:first-child]:rounded-s-xl [&>:last-child]:rounded-e-xl',
                    )}
                  >
                    {/* The path takes the room the figures leave (`w-full max-w-0`, the usual table recipe for a
                        column that truncates), so one long unbroken path cannot widen the table for every row. */}
                    <th scope="row" className="w-full max-w-0 px-3 py-2.5 text-start font-normal">
                      <RowLink href={traffic} />
                      <div className="flex min-w-0 items-center gap-2">
                        {/* The link's own text starts with the method, so the badge would read it twice. */}
                        <span aria-hidden="true" className="shrink-0">
                          <MethodBadge method={row.method} />
                        </span>
                        <Link
                          href={traffic}
                          dir="ltr"
                          title={row.path}
                          className={cn(FIGURE_LINK, 'min-w-0 truncate font-mono text-xs')}
                        >
                          <span className="sr-only">{row.method}</span>{' '}
                          {row.path}
                        </Link>
                      </div>
                    </th>
                    <td className="whitespace-nowrap px-3 py-2.5">
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
                    <td className={cn('whitespace-nowrap px-3 py-2.5 text-end', flagged && FLAGGED_RATE)}>
                      {canSearch && errorsHref && row.errors > 0 ? (
                        <Link href={errorsHref} className={FIGURE_LINK}>
                          <span className="sr-only">
                            {t('viewFailed', { name: `${row.method} ${row.path}` })}
                          </span>{' '}
                          {errorRate}
                        </Link>
                      ) : (
                        errorRate
                      )}
                      {flagged && <span className="sr-only"> {t('highErrorRate')}</span>}
                      {flagged && <span aria-hidden="true">{' ▲'}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-end">{fmt.ms(row.avgLatencyMs)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-end">{fmt.ms(row.p95LatencyMs)}</td>
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
