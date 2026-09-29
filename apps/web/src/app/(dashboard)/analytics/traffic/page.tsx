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

function TrafficView() {
  const t = useTranslations('analytics.traffic');
  const { filters, update, reset } = useTrafficFilters();
  const { data: health } = useAnalyticsHealth();
  const traffic = useAnalyticsTraffic(filters);
  const { data, error, refetch, isPlaceholderData } = traffic;

  return (
    <div className="space-y-3">
      <PageHeader title={t('title')} description={t('subtitle')} />

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
              <TrafficKpis data={data} />
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(16rem,0.6fr)]">
                <TrafficVolumeChart data={data} />
                <TrafficLatencyChart data={data} />
                <div className="xl:row-span-1">
                  <TrafficMix data={data} />
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <EndpointTable
                  title={t('endpoints.topTitle')}
                  description={t('endpoints.topDescription')}
                  rows={data?.topEndpoints}
                  loading={!data}
                  emphasis="requests"
                  emptyMessage={t('endpoints.empty')}
                />
                <EndpointTable
                  title={t('endpoints.slowTitle')}
                  description={t('endpoints.slowDescription')}
                  rows={data?.slowestEndpoints}
                  loading={!data}
                  emphasis="p95"
                  emptyMessage={t('endpoints.empty')}
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
