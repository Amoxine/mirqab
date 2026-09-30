'use client';

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  AnalyticsEmptyState,
  AnalyticsErrorState,
  AnalyticsStaleNotice,
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { ApiFormSheet } from '@/components/apis/api-form-sheet';
import { PermissionGate } from '@/components/auth/permission-gate';
import { ApiTrafficTable } from '@/components/dashboard/api-traffic-table';
import { EndpointTrafficTable } from '@/components/dashboard/endpoint-traffic-table';
import { ScopeChip } from '@/components/dashboard/scope-chip';
import { GatewayMap } from '@/components/dashboard/gateway-map';
import { KpiStrip } from '@/components/dashboard/kpi-strip';
import { OverviewPanel } from '@/components/dashboard/overview-panel';
import { RangeControl } from '@/components/dashboard/range-control';
import { RecentActivityCard } from '@/components/dashboard/recent-activity-card';
import { SpecUpdatesCard } from '@/components/dashboard/spec-updates-card';
import { SyncSummaryCard } from '@/components/dashboard/sync-summary-card';
import { TopApisCard } from '@/components/dashboard/top-apis-card';
import { TrafficChart } from '@/components/dashboard/traffic-chart';
import { ErrorsMini, LatencyMini } from '@/components/dashboard/trend-minis';
import { useOverlays } from '@/components/layout/overlays-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsHealth } from '@/hooks/use-analytics';
import { useDashboardScope, type DashboardScope } from '@/hooks/use-dashboard-scope';
import { usePermissions } from '@/hooks/use-permissions';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';

/** Staggered entrance (with the `motion-enter` class): each block 70 ms after the previous one; collapses under reduced motion. */
const rise = (i: number): CSSProperties => ({
  animationDelay: `${String(i * 70)}ms`,
  animationFillMode: 'both',
});

/** The request that feeds the page's figures, shown as the page's "route". */
function RequestLine({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('dashboard.page');
  return (
    <p
      className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 font-mono text-xs"
      title={t('requestLineHint')}
    >
      <span className="bg-primary/10 text-primary rounded-md px-1.5 py-0.5 text-[0.66rem] font-medium tracking-wider">
        {'GET'}
      </span>
      <span dir="ltr">
        <span className="text-foreground">{'/analytics/overview'}</span>
        {`?range=${range}`}
      </span>
    </p>
  );
}

/** Stats, trends, topology and top APIs; the topology column only for users who may read gateway state. */
function Hero({
  range,
  canSettings,
  scope,
  children,
}: {
  range: AnalyticsRange;
  canSettings: boolean;
  scope: DashboardScope['api'];
  children?: React.ReactNode;
}) {
  const t = useTranslations('dashboard.page');
  return (
    <section
      aria-label={t('summary')}
      className={cn(
        'grid gap-3 lg:grid-cols-2',
        canSettings && 'xl:grid-cols-[minmax(22rem,1.05fr)_minmax(0,1.5fr)_minmax(15rem,0.8fr)]',
      )}
    >
      <div className="motion-enter flex min-w-0 flex-col gap-3" style={rise(1)}>
        {children ?? (
          <>
            <OverviewPanel range={range} scope={scope} />
            <div className="grid gap-3 sm:grid-cols-2">
              <LatencyMini range={range} apiId={scope?.id} />
              <ErrorsMini range={range} apiId={scope?.id} />
            </div>
          </>
        )}
      </div>
      {canSettings && (
        <div
          className="motion-enter min-w-0 lg:order-last lg:col-span-2 xl:order-none xl:col-span-1"
          style={rise(0)}
        >
          {/* A card, so the map fills its grid cell to the height of its neighbours instead of floating in gaps. */}
          <Card className="flex h-full flex-col p-4">
            <GatewayMap />
          </Card>
        </div>
      )}
      {!children && (
        <div className="motion-enter flex min-w-0" style={rise(2)}>
          <TopApisCard range={range} scope={scope} />
        </div>
      )}
    </section>
  );
}

/** The cards below the figures that do not depend on analytics, side by side when analytics cannot fill the row. */
function Plain({ syncSpec, activity }: { syncSpec: ReactNode; activity: ReactNode }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2 [&>*]:h-full">
      {syncSpec}
      {activity}
    </div>
  );
}

function AnalyticsDashboard({
  range,
  canSettings,
  scope,
  onSelectApi,
  syncSpec,
  activity,
}: {
  range: AnalyticsRange;
  canSettings: boolean;
  /** The API the API cards are narrowed to (the only managed API, or the one picked); null for the gateway-wide view. */
  scope: DashboardScope['api'];
  onSelectApi: (apiId: string) => void;
  /** API sync status and pending spec updates: stacked under the traffic table. */
  syncSpec: ReactNode;
  /** Recent activity: stacked under the request-volume chart. */
  activity: ReactNode;
}) {
  const { data: health, isLoading, error, refetch } = useAnalyticsHealth();
  const t = useTranslations('dashboard.page');

  if (isLoading) {
    return (
      <div className="grid gap-3 lg:grid-cols-3" aria-busy="true">
        <Skeleton className="h-80 rounded-[1.25rem]" />
        <Skeleton className="h-80 rounded-[1.25rem]" />
        <Skeleton className="h-80 rounded-[1.25rem]" />
      </div>
    );
  }
  if (error || !health) {
    return (
      <div className="space-y-3">
        <Card>
          <AnalyticsErrorState
            message={error?.message ?? t('noAnalyticsHealth')}
            onRetry={() => void refetch()}
          />
        </Card>
        <Plain syncSpec={syncSpec} activity={activity} />
      </div>
    );
  }
  // Only once the pump reports ready (or stale with earlier rows) — never zeros shown as fact.
  if (!health.pipelineReady && !isPipelineStale(health)) {
    return (
      <div className="space-y-3">
        <Hero range={range} canSettings={canSettings} scope={scope}>
          <Card className="rounded-[1.25rem]">
            <AnalyticsEmptyState health={health} />
          </Card>
        </Hero>
        <Plain syncSpec={syncSpec} activity={activity} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {!health.pipelineReady && <AnalyticsStaleNotice health={health} />}
      <Hero range={range} canSettings={canSettings} scope={scope} />
      <div className="motion-enter" style={rise(2)}>
        <KpiStrip range={range} showNodes={canSettings} apiId={scope?.id} />
      </div>
      {/* Two stacks of near-equal height: the table grows and the activity log grows to absorb
          the difference, so neither column ends in a blank strip. */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(22rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="motion-enter flex-1 [&>*]:h-full" style={rise(3)}>
            {scope ? (
              <EndpointTrafficTable range={range} scope={scope} />
            ) : (
              <ApiTrafficTable range={range} onSelect={onSelectApi} />
            )}
          </div>
          {syncSpec}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="motion-enter" style={rise(4)}>
            <TrafficChart range={range} scope={scope} />
          </div>
          <div className="flex-1 [&>*]:h-full">{activity}</div>
        </div>
      </div>
    </div>
  );
}

/** Refetches every analytics figure on the page; spins while any of them is loading. */
function RefreshButton() {
  const t = useTranslations('dashboard.page');
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ queryKey: queryKeys.analytics.all }) > 0;
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={fetching}
      onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all })}
      className="gap-2"
    >
      {t('refresh')}
      <RefreshCw
        className={cn('h-4 w-4', fetching && 'motion-safe:animate-spin')}
        aria-hidden="true"
      />
    </Button>
  );
}

function QuickLink({
  href,
  icon: Icon,
  label,
}: {
  href: '/apis' | '/keys' | '/tenants';
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Button asChild variant="ghost" size="sm" className="gap-2">
      <Link href={href}>
        <Icon className="text-muted-foreground" aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}

export default function DashboardPage() {
  const t = useTranslations('dashboard.page');
  const { can } = usePermissions();
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const [createOpen, setCreateOpen] = useState(false);
  const { openSearch } = useOverlays();
  const canAnalytics = can('analytics:read');
  const canSettings = can('settings:read');
  const scope = useDashboardScope();

  // Cards that do not depend on analytics; where they sit is decided by the layout that wraps them.
  const syncSpec = (
    <>
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
    </>
  );
  const activity = (
    <PermissionGate permission="audit:read">
      <div className="motion-enter" style={rise(6)}>
        <RecentActivityCard scope={scope.api} />
      </div>
    </PermissionGate>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pb-0 pt-1">
        <div className="flex min-w-0 items-center gap-4 sm:gap-[1.125rem]">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={openSearch}
            title={t('searchHint')}
            aria-label={t('search')}
            className="size-12 shrink-0 shadow-[0_10px_22px_-12px_rgb(0_0_0/0.55)] hover:-rotate-6 hover:scale-105 sm:size-14"
          >
            <Search className="size-5" aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-balance text-[clamp(2rem,3.4vw,3.1rem)] font-light leading-[1.05] tracking-[-0.04em]">
              {t('title')}
            </h1>
            <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('subtitle')}</p>
            {canAnalytics && <RequestLine range={range} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canAnalytics && !scope.auto && scope.api && (
            <ScopeChip name={scope.api.name} onClear={scope.clear} />
          )}
          {canAnalytics && <RangeControl value={range} onChange={setRange} />}
          {canAnalytics && <RefreshButton />}
          <PermissionGate permission="api:create">
            <Button
              type="button"
              onClick={() => {
                setCreateOpen(true);
              }}
              className="gap-2"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('createApi')}
            </Button>
          </PermissionGate>
        </div>
      </div>

      {canAnalytics ? (
        <AnalyticsDashboard
          range={range}
          canSettings={canSettings}
          scope={scope.api}
          onSelectApi={scope.select}
          syncSpec={syncSpec}
          activity={activity}
        />
      ) : (
        <>
          {canSettings && (
            <Card className="rounded-[1.25rem] p-5">
              <GatewayMap />
            </Card>
          )}
          <Plain syncSpec={syncSpec} activity={activity} />
        </>
      )}

      {/* One slim row instead of a tall card: the shortcuts are a convenience, not a section. */}
      <Card className="flex flex-wrap items-center gap-x-2 gap-y-1 p-2 ps-4">
        <h2 className="text-muted-foreground me-2 text-sm font-normal">{t('quickActions')}</h2>
        <PermissionGate permission="api:read">
          <QuickLink href="/apis" icon={ShieldCheck} label={t('manageApis')} />
        </PermissionGate>
        <PermissionGate permission="key:read">
          <QuickLink href="/keys" icon={KeyRound} label={t('manageKeys')} />
        </PermissionGate>
        <PermissionGate permission="tenant:read">
          <QuickLink href="/tenants" icon={Users} label={t('manageTenants')} />
        </PermissionGate>
      </Card>
      <PermissionGate permission="api:create">
        <ApiFormSheet mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      </PermissionGate>
    </div>
  );
}
