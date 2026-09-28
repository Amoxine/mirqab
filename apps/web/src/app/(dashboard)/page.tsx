'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, KeyRound, ShieldCheck, Users } from 'lucide-react';
import {
  AnalyticsEmptyState,
  AnalyticsErrorState,
  AnalyticsStaleNotice,
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { PermissionGate } from '@/components/auth/permission-gate';
import { ApiTrafficTable } from '@/components/dashboard/api-traffic-table';
import { GatewayTopology } from '@/components/dashboard/gateway-topology';
import { OverviewPanel } from '@/components/dashboard/overview-panel';
import { RangeControl } from '@/components/dashboard/range-control';
import { RecentActivityCard } from '@/components/dashboard/recent-activity-card';
import { SpecUpdatesCard } from '@/components/dashboard/spec-updates-card';
import { SyncSummaryCard } from '@/components/dashboard/sync-summary-card';
import { TopApisCard } from '@/components/dashboard/top-apis-card';
import { TrafficChart } from '@/components/dashboard/traffic-chart';
import { ErrorsMini, LatencyMini } from '@/components/dashboard/trend-minis';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsHealth } from '@/hooks/use-analytics';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';

/** Staggered entrance (with the `motion-enter` class): each block 70 ms after the previous one; collapses under reduced motion. */
const rise = (i: number): CSSProperties => ({ animationDelay: `${String(i * 70)}ms`, animationFillMode: 'both' });

/** The request that feeds the page's figures, shown as the page's "route". */
function RequestLine({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('dashboard.page');
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground" title={t('requestLineHint')}>
      <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.66rem] font-medium tracking-wider text-primary">{'GET'}</span>
      <span dir="ltr">
        <span className="text-foreground">{'/analytics/overview'}</span>
        {`?range=${range}`}
      </span>
    </p>
  );
}

/** Stats, trends, topology and top APIs; the topology column only for users who may read gateway state. */
function Hero({ range, canSettings, children }: { range: AnalyticsRange; canSettings: boolean; children?: React.ReactNode }) {
  const t = useTranslations('dashboard.page');
  return (
    <section
      aria-label={t('summary')}
      className={cn(
        'grid gap-4 lg:grid-cols-2',
        canSettings && 'xl:grid-cols-[minmax(22rem,1.05fr)_minmax(0,1.5fr)_minmax(15rem,0.8fr)]',
      )}
    >
      <div className="motion-enter flex min-w-0 flex-col gap-3" style={rise(1)}>
        {children ?? (
          <>
            <OverviewPanel range={range} />
            <div className="grid gap-3 sm:grid-cols-2">
              <LatencyMini range={range} />
              <ErrorsMini range={range} />
            </div>
          </>
        )}
      </div>
      {canSettings && (
        <div className="motion-enter min-w-0 lg:order-last lg:col-span-2 xl:order-none xl:col-span-1 xl:self-center" style={rise(0)}>
          <GatewayTopology />
        </div>
      )}
      {!children && (
        <div className="motion-enter flex min-w-0" style={rise(2)}>
          <TopApisCard range={range} />
        </div>
      )}
    </section>
  );
}

function AnalyticsDashboard({ range, canSettings }: { range: AnalyticsRange; canSettings: boolean }) {
  const { data: health, isLoading, error, refetch } = useAnalyticsHealth();
  const t = useTranslations('dashboard.page');

  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-3" aria-busy="true">
        <Skeleton className="h-80 rounded-[1.25rem]" />
        <Skeleton className="h-80 rounded-[1.25rem]" />
        <Skeleton className="h-80 rounded-[1.25rem]" />
      </div>
    );
  }
  if (error || !health) {
    return (
      <Card>
        <AnalyticsErrorState message={error?.message ?? t('noAnalyticsHealth')} onRetry={() => void refetch()} />
      </Card>
    );
  }
  // Only once the pump reports ready (or stale with earlier rows) — never zeros shown as fact.
  if (!health.pipelineReady && !isPipelineStale(health)) {
    return (
      <Hero range={range} canSettings={canSettings}>
        <Card className="rounded-[1.25rem]">
          <AnalyticsEmptyState health={health} />
        </Card>
      </Hero>
    );
  }
  return (
    <div className="space-y-4">
      {!health.pipelineReady && <AnalyticsStaleNotice health={health} />}
      <Hero range={range} canSettings={canSettings} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(22rem,1fr)]">
        <div className="motion-enter" style={rise(3)}>
          <ApiTrafficTable range={range} />
        </div>
        <div className="motion-enter" style={rise(4)}>
          <TrafficChart range={range} />
        </div>
      </div>
    </div>
  );
}

const quickLink =
  'group flex min-h-11 items-center gap-3 rounded-full px-3.5 py-2 text-sm font-medium transition-colors hover:bg-foreground/[0.06]';

export default function DashboardPage() {
  const t = useTranslations('dashboard.page');
  const { can } = usePermissions();
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const canAnalytics = can('analytics:read');
  const canSettings = can('settings:read');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-1 pt-3">
        <div className="min-w-0">
          <h1 className="text-[clamp(2rem,3.4vw,3.1rem)] font-light leading-[1.05] tracking-[-0.04em] text-balance">{t('title')}</h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">{t('subtitle')}</p>
          {canAnalytics && <RequestLine range={range} />}
        </div>
        {canAnalytics && <RangeControl value={range} onChange={setRange} />}
      </div>

      {canAnalytics ? (
        <AnalyticsDashboard range={range} canSettings={canSettings} />
      ) : (
        canSettings && (
          <Card className="rounded-[1.25rem] p-5">
            <GatewayTopology />
          </Card>
        )
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <PermissionGate permission="settings:read">
          <div className="motion-enter" style={rise(5)}>
            <SyncSummaryCard />
          </div>
        </PermissionGate>
        <PermissionGate permission="api:read">
          <div className="motion-enter" style={rise(6)}>
            <SpecUpdatesCard />
          </div>
        </PermissionGate>
      </div>

      <div className="grid gap-4 lg:grid-cols-7">
        <div className="lg:col-span-4">
          <PermissionGate permission="audit:read">
            <RecentActivityCard />
          </PermissionGate>
        </div>
        <Card className="rounded-[1.25rem] lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-lg font-normal">{t('quickActions')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <PermissionGate permission="api:read">
              <Link href="/apis" className={quickLink}>
                <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('manageApis')}
                <ArrowUpRight className="ms-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 rtl:-scale-x-100" aria-hidden="true" />
              </Link>
            </PermissionGate>
            <PermissionGate permission="key:read">
              <Link href="/keys" className={quickLink}>
                <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('manageKeys')}
                <ArrowUpRight className="ms-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 rtl:-scale-x-100" aria-hidden="true" />
              </Link>
            </PermissionGate>
            <PermissionGate permission="tenant:read">
              <Link href="/tenants" className={quickLink}>
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('manageTenants')}
                <ArrowUpRight className="ms-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 rtl:-scale-x-100" aria-hidden="true" />
              </Link>
            </PermissionGate>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
