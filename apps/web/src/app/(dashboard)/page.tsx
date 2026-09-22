'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Activity, AlertTriangle, KeyRound, ShieldCheck, Timer, Users } from 'lucide-react';
import {
  AnalyticsEmptyState,
  AnalyticsErrorState,
  AnalyticsStaleNotice,
  formatMs,
  formatPercent,
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { PermissionGate } from '@/components/auth/permission-gate';
import { GatewayHealthCard } from '@/components/dashboard/gateway-health-card';
import { RecentActivityCard } from '@/components/dashboard/recent-activity-card';
import { SyncSummaryCard } from '@/components/dashboard/sync-summary-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsHealth, useAnalyticsOverview } from '@/hooks/use-analytics';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
}

function StatCard({ title, value, icon: Icon, description }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20" />
        <Skeleton className="mt-2 h-3 w-32" />
      </CardContent>
    </Card>
  );
}

/** Only mounted once the pump pipeline reports ready, so the overview is never shown as zeros-as-fact. */
function OverviewTiles() {
  const { data, isLoading, error, refetch } = useAnalyticsOverview('24h');
  const t = useTranslations('dashboard.page');

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
        value={data.totalRequests.toLocaleString()}
        icon={Activity}
        description={t('stats.requestsDescription')}
      />
      <StatCard
        title={t('stats.errorRate')}
        value={hasTraffic ? formatPercent(data.errorRate) : '—'}
        icon={AlertTriangle}
        description={t('stats.errorsDescription', { count: data.errorCount.toLocaleString() })}
      />
      <StatCard
        title={t('stats.avgLatency')}
        value={hasTraffic ? formatMs(data.avgLatencyMs) : '—'}
        icon={Timer}
        description={hasTraffic ? t('stats.upstreamDescription', { ms: formatMs(data.avgUpstreamLatencyMs) }) : undefined}
      />
      <StatCard
        title={t('stats.activeApis')}
        value={data.activeApis}
        icon={ShieldCheck}
        description={t('stats.activeKeysDescription', { count: data.activeKeys.toLocaleString() })}
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
        <Link href="/analytics" className="text-sm text-primary hover:underline">
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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
      </div>

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
          <CardContent className="space-y-2">
            <PermissionGate permission="api:read">
              <Link href="/apis" className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent">
                <ShieldCheck className="h-4 w-4" />
                {t('manageApis')}
              </Link>
            </PermissionGate>
            <PermissionGate permission="key:read">
              <Link href="/keys" className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent">
                <KeyRound className="h-4 w-4" />
                {t('manageKeys')}
              </Link>
            </PermissionGate>
            <PermissionGate permission="tenant:read">
              <Link href="/tenants" className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent">
                <Users className="h-4 w-4" />
                {t('manageTenants')}
              </Link>
            </PermissionGate>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
