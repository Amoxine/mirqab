'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Activity, AlertTriangle, KeyRound, ShieldCheck, Timer, Users } from 'lucide-react';
import {
  AnalyticsEmptyState,
  AnalyticsErrorState,
  AnalyticsStaleNotice,
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { PermissionGate } from '@/components/auth/permission-gate';
import { GatewayHealthCard } from '@/components/dashboard/gateway-health-card';
import { RecentActivityCard } from '@/components/dashboard/recent-activity-card';
import { StatCard, StatCardSkeleton } from '@/components/dashboard/stat-card';
import { SyncSummaryCard } from '@/components/dashboard/sync-summary-card';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAnalyticsHealth, useAnalyticsOverview } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';

/** Only mounted once the pump pipeline reports ready, so the overview is never shown as zeros-as-fact. */
function OverviewTiles() {
  const { data, isLoading, error, refetch } = useAnalyticsOverview('24h');
  const t = useTranslations('dashboard.page');
  const fmt = useFormat();

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <AnalyticsErrorState message={error?.message ?? t('noAnalytics')} onRetry={() => void refetch()} />
      </Card>
    );
  }

  const hasTraffic = data.totalRequests > 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title={t('stats.requests')}
        value={fmt.number(data.totalRequests)}
        icon={Activity}
        description={t('stats.requestsDescription')}
      />
      <StatCard
        title={t('stats.errorRate')}
        value={hasTraffic ? fmt.percent(data.errorRate) : '—'}
        icon={AlertTriangle}
        description={t('stats.errorsDescription', { count: fmt.number(data.errorCount) })}
      />
      <StatCard
        title={t('stats.avgLatency')}
        value={hasTraffic ? fmt.ms(data.avgLatencyMs) : '—'}
        icon={Timer}
        description={hasTraffic ? t('stats.upstreamDescription', { ms: fmt.ms(data.avgUpstreamLatencyMs) }) : undefined}
      />
      <StatCard
        title={t('stats.activeApis')}
        value={fmt.number(data.activeApis)}
        icon={ShieldCheck}
        description={t('stats.activeKeysDescription', { count: fmt.number(data.activeKeys) })}
      />
    </div>
  );
}

function AnalyticsSection() {
  const { data: health, isLoading, error, refetch } = useAnalyticsHealth();
  const t = useTranslations('dashboard.page');

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('traffic')}</h2>
        <Link href="/analytics" className="rounded-sm text-sm font-medium text-primary hover:underline">
          {t('viewAnalytics')}
        </Link>
      </div>
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : error || !health ? (
        <Card>
          <AnalyticsErrorState message={error?.message ?? t('noAnalyticsHealth')} onRetry={() => void refetch()} />
        </Card>
      ) : health.pipelineReady || isPipelineStale(health) ? (
        <>
          {!health.pipelineReady && <AnalyticsStaleNotice health={health} />}
          <OverviewTiles />
        </>
      ) : (
        <Card>
          <AnalyticsEmptyState health={health} />
        </Card>
      )}
    </section>
  );
}

export default function DashboardPage() {
  const t = useTranslations('dashboard.page');

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      <PermissionGate permission="analytics:read">
        <div className="grid gap-4 lg:grid-cols-3">
          <GatewayHealthCard />
          <div className="lg:col-span-2">
            <SyncSummaryCard />
          </div>
        </div>
        <AnalyticsSection />
      </PermissionGate>

      <div className="grid gap-4 lg:grid-cols-7">
        <div className="lg:col-span-4">
          <PermissionGate permission="audit:read">
            <RecentActivityCard />
          </PermissionGate>
        </div>
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">{t('quickActions')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <PermissionGate permission="api:read">
              <Link href="/apis" className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent pointer-coarse:min-h-11">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('manageApis')}
              </Link>
            </PermissionGate>
            <PermissionGate permission="key:read">
              <Link href="/keys" className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent pointer-coarse:min-h-11">
                <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('manageKeys')}
              </Link>
            </PermissionGate>
            <PermissionGate permission="tenant:read">
              <Link href="/tenants" className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent pointer-coarse:min-h-11">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('manageTenants')}
              </Link>
            </PermissionGate>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
