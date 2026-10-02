'use client';

import Link from 'next/link';
import { Activity, Crosshair } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { ApiStatusBadge } from '@/components/apis/api-status-badge';
import { ApiNodeIcon } from '@/components/dashboard/api-node-icon';
import { FIGURE_LINK, RowLink, rowLinkProps } from '@/components/shared/row-link';
import { StateMessage } from '@/components/shared/state-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsApis } from '@/hooks/use-analytics';
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { useFormat } from '@/hooks/use-format';
import { usePermissions } from '@/hooks/use-permissions';
import { searchHref, searchToken, trafficHref } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';
import { ERROR_FLAG, FLAGGED_RATE } from './traffic-table';

/** Per-API traffic for the range: volume with its share of the busiest API, error rate and latency. */
export function ApiTrafficTable({
  range,
  onSelect,
}: {
  range: AnalyticsRange;
  /** Narrows the whole dashboard to one API; each row gets a button for it. */
  onSelect?: (apiId: string) => void;
}) {
  const t = useTranslations('dashboard.apiTraffic');
  const tAnalytics = useTranslations('analytics');
  const tRanges = useTranslations('analytics.ranges');
  const locale = useLocale();
  const fmt = useFormat();
  const { data, isLoading, error, refetch } = useAnalyticsApis(range);
  const canSearch = useCanSearchRequests();
  const { can } = usePermissions();
  const max = Math.max(...(data ?? []).map((row) => row.requests), 1);

  return (
    <Card variant="ink" className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
        <div>
          <h2 className="text-lg font-normal tracking-tight">{t('title')}</h2>
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
      ) : !data?.length ? (
        <StateMessage
          icon={<Activity aria-hidden="true" />}
          message={tAnalytics('table.apiEmpty')}
          className="py-10"
        />
      ) : (
        // Columns stay aligned for comparison; on phones the table scrolls inside the card. `relative`: the
        // sr-only texts in the rows are absolutely positioned, and without a positioned scroller they sit
        // outside its clip and widen the page.
        <div className="relative overflow-x-auto px-3 pb-3 pt-2 sm:px-4">
          <table className="w-full min-w-[28rem] border-separate border-spacing-y-1 text-start">
            <thead>
              <tr className="text-muted-foreground font-mono text-[0.68rem] uppercase tracking-[0.08em]">
                <th scope="col" className="px-3 py-2 text-start font-normal">
                  {tAnalytics('table.columns.api')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-normal">
                  {tAnalytics('table.columns.requests')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-normal">
                  {tAnalytics('table.columns.errorRate')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-normal">
                  {tAnalytics('table.columns.avgLatency')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-normal">
                  {t('status')}
                </th>
              </tr>
            </thead>
            <tbody className="text-sm tabular-nums">
              {data.map((row) => {
                const flagged = row.requests > 0 && row.errorRate >= ERROR_FLAG;
                // The row opens this API's traffic (a click on it follows the hidden row link; the request
                // count is the keyboard's way to the same place); its failures open the search for them
                // (errors are status 400 and up). The figure links say whose they are in their own text,
                // since a number alone names nothing and the API name is a link only with api:read.
                const traffic = trafficHref({ range, apiId: row.apiDefId });
                const errorsHref = searchHref([searchToken('api', row.apiDefId), 'status:>=400'], range);
                const errorRate = fmt.percent(row.errorRate);
                return (
                  <tr
                    key={row.apiDefId}
                    {...rowLinkProps(
                      'hover:bg-accent transition-colors [&>:first-child]:rounded-s-xl [&>:last-child]:rounded-e-xl',
                    )}
                  >
                    {/* The name takes the room the figures leave (`w-full max-w-0`, the usual table recipe for a
                        column that truncates), so one long unbroken name cannot widen the table for every row. */}
                    <th scope="row" className="w-full max-w-0 px-3 py-2.5 text-start font-normal">
                      <RowLink href={traffic} />
                      <div className="flex items-center gap-3">
                        <span className="bg-muted text-primary grid size-8 shrink-0 place-items-center rounded-full">
                          <ApiNodeIcon className="size-4" />
                        </span>
                        <div className="min-w-0">
                          {can('api:read') ? (
                            <Link
                              href={`/apis/${row.apiDefId}`}
                              dir="auto"
                              title={row.name}
                              className="inline-block max-w-full truncate text-start align-bottom font-medium hover:underline"
                            >
                              {row.name}
                            </Link>
                          ) : (
                            <span dir="auto" title={row.name} className="block truncate text-start font-medium">
                              {row.name}
                            </span>
                          )}
                          <span title={row.slug} className="text-muted-foreground block truncate font-mono text-xs">
                            {row.slug}
                          </span>
                        </div>
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
                        <Link href={traffic} className={FIGURE_LINK} title={fmt.number(row.requests)}>
                          <span className="sr-only">{t('viewTraffic', { name: row.name })}</span>{' '}
                          {formatCount(row.requests, locale)}
                        </Link>
                      </div>
                    </td>
                    <td className={cn('whitespace-nowrap px-3 py-2.5 text-end', flagged && FLAGGED_RATE)}>
                      {row.requests === 0 ? (
                        '—'
                      ) : canSearch && row.errors > 0 ? (
                        <Link href={errorsHref} className={FIGURE_LINK}>
                          <span className="sr-only">{t('viewFailed', { name: row.name })}</span>{' '}
                          {errorRate}
                        </Link>
                      ) : (
                        errorRate
                      )}
                      {flagged && <span className="sr-only"> {t('highErrorRate')}</span>}
                      {flagged && <span aria-hidden="true">{' ▲'}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-end">
                      {row.requests > 0 ? fmt.ms(row.avgLatencyMs) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-end">
                      <div className="flex items-center justify-end gap-1">
                        <ApiStatusBadge status={row.status} />
                        {onSelect && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={t('focus', { name: row.name })}
                            title={t('focus', { name: row.name })}
                            onClick={() => {
                              onSelect(row.apiDefId);
                            }}
                          >
                            <Crosshair aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </td>
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
