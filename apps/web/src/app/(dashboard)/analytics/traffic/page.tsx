'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate } from '@/components/auth/permission-gate';
import {
  AnalyticsEmptyState,
  AnalyticsErrorState,
  AnalyticsStaleNotice,
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { EndpointTable, TrafficMix } from '@/components/analytics/traffic/traffic-breakdowns';
import {
  TrafficLatencyChart,
  TrafficVolumeChart,
} from '@/components/analytics/traffic/traffic-charts';
import { TrafficFilterBar } from '@/components/analytics/traffic/traffic-filter-bar';
import { TrafficKpis } from '@/components/analytics/traffic/traffic-kpis';
import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsHealth, useAnalyticsTraffic } from '@/hooks/use-analytics';
import { useTrafficFilters } from '@/hooks/use-traffic-filters';
import { useSettledText } from '@/hooks/use-settled-text';
import { useTrafficSearchHref } from '@/hooks/use-traffic-search-href';
import { endpointTokens } from '@/lib/traffic-filters-to-query';
import type { TrafficEndpoint, TrafficFilters } from '@/types';

/** The filters that narrow the traffic (the range is the window, not a filter). */
const FILTER_KEYS = ['apiId', 'keyId', 'method', 'statusClass', 'status', 'path', 'minLatencyMs', 'auth'] as const;
const countFilters = (filters: TrafficFilters): number =>
  FILTER_KEYS.filter((key) => filters[key] !== undefined && filters[key] !== '').length;

function TrafficView() {
  const t = useTranslations('analytics.traffic');
  const { filters, update, reset } = useTrafficFilters();
  const { data: health } = useAnalyticsHealth();
  const traffic = useAnalyticsTraffic(filters);
  const { data, error, refetch, isPlaceholderData } = traffic;
  // The figures open the requests behind them: this page's filters as a request search.
  const searchHref = useTrafficSearchHref(filters);
  // Picking a filter changes the page in place, which is silent without a live region: this says how
  // many requests now match and how many filters apply. Only a settled result is said (not the stale
  // numbers shown while a change loads), and only when it differs from what was last said.
  const announced = useSettledText(
    t('announce', { requests: data?.summary.requests ?? 0, filters: countFilters(filters) }),
    data !== undefined && !isPlaceholderData,
  );
  // One endpoint's requests: its exact path and method replace the page's own method and path filters.
  // None for a path search cannot write: a link without it would list more than the row counts.
  const endpointHref = (row: TrafficEndpoint) => {
    const tokens = endpointTokens(row);
    return tokens ? searchHref({ method: undefined, path: undefined }, tokens) : undefined;
  };

  return (
    <div className="space-y-3">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <p role="status" className="sr-only">
        {announced}
      </p>

      {health && !health.pipelineReady && !isPipelineStale(health) ? (
        // The pump is not delivering rows: one explanation instead of a wall of empty charts.
        <Card>
          <AnalyticsEmptyState health={health} />
        </Card>
      ) : (
        <>
          {health && isPipelineStale(health) && <AnalyticsStaleNotice health={health} />}
          <TrafficFilterBar filters={filters} onChange={update} onReset={reset} />
          {error && !data ? (
            <Card>
              <AnalyticsErrorState message={error.message} onRetry={() => void refetch()} />
            </Card>
          ) : (
            // While a filter change loads, the previous numbers stay (dimmed) instead of flashing skeletons.
            <div
              className={
                isPlaceholderData
                  ? 'space-y-3 opacity-60 transition-opacity'
                  : 'space-y-3 transition-opacity'
              }
              aria-busy={isPlaceholderData}
            >
              <TrafficKpis data={data} searchHref={searchHref} />
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(16rem,0.6fr)]">
                <TrafficVolumeChart data={data} />
                <TrafficLatencyChart data={data} />
                <div className="xl:row-span-1">
                  <TrafficMix data={data} filters={filters} onChange={update} />
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                {/* An endpoint's own method and path replace the page's, the other filters stay. */}
                <EndpointTable
                  title={t('endpoints.topTitle')}
                  description={t('endpoints.topDescription')}
                  rows={data?.topEndpoints}
                  loading={!data}
                  emphasis="requests"
                  emptyMessage={t('endpoints.empty')}
                  rowHref={endpointHref}
                />
                <EndpointTable
                  title={t('endpoints.slowTitle')}
                  description={t('endpoints.slowDescription')}
                  rows={data?.slowestEndpoints}
                  loading={!data}
                  emphasis="p95"
                  emptyMessage={t('endpoints.empty')}
                  rowHref={endpointHref}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function TrafficPage() {
  return (
    <PagePermissionGate permission="analytics:read">
      {/* `useSearchParams` (the filters live in the URL) needs a Suspense boundary for static rendering. */}
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-[1.25rem]" />}>
        <TrafficView />
      </Suspense>
    </PagePermissionGate>
  );
}
