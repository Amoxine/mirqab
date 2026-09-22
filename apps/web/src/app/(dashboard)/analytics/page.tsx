'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Activity, AlertTriangle, CheckCircle, Clock, KeyRound, ShieldCheck } from 'lucide-react';
import { PagePermissionGate } from '@/components/auth/permission-gate';
import {
  AnalyticsEmptyState,
  AnalyticsErrorState,
  AnalyticsStaleNotice,
  formatMs,
  formatPercent,
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { LatencyChart } from '@/components/analytics/latency-chart';
import { RequestsChart } from '@/components/analytics/requests-chart';
import { StatusCodeChart } from '@/components/analytics/status-code-chart';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ANALYTICS_RANGES,
  useAnalyticsApis,
  useAnalyticsHealth,
  useAnalyticsKeys,
  useAnalyticsOverview,
} from '@/hooks/use-analytics';
import type { AnalyticsApiRow, AnalyticsKeyRow, AnalyticsRange } from '@/types';

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

function OverviewTiles({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const { data, isLoading, error, refetch } = useAnalyticsOverview(range);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <AnalyticsErrorState message={error?.message ?? t('noData')} onRetry={() => void refetch()} />
      </Card>
    );
  }

  // Rates and latencies are undefined without traffic: show a dash rather than a made-up 0.
  const hasTraffic = data.totalRequests > 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard title={t('overview.totalRequests')} value={data.totalRequests.toLocaleString()} icon={Activity} />
      <StatCard
        title={t('table.columns.errorRate')}
        value={hasTraffic ? formatPercent(data.errorRate) : '—'}
        icon={CheckCircle}
        description={t('overview.successCount', { count: data.successCount.toLocaleString() })}
      />
      <StatCard
        title={t('table.columns.avgLatency')}
        value={hasTraffic ? formatMs(data.avgLatencyMs) : '—'}
        icon={Clock}
        description={hasTraffic ? t('overview.upstreamLatency', { value: formatMs(data.avgUpstreamLatencyMs) }) : undefined}
      />
      <StatCard title={t('table.columns.errors')} value={data.errorCount.toLocaleString()} icon={AlertTriangle} />
      <StatCard title={t('overview.activeApis')} value={data.activeApis} icon={ShieldCheck} />
      <StatCard title={t('overview.activeKeys')} value={data.activeKeys} icon={KeyRound} />
    </div>
  );
}

interface Column<T> {
  header: string;
  numeric?: boolean;
  cell: (row: T) => ReactNode;
}

interface MetricsTableCardProps<T> {
  title: string;
  query: UseQueryResult<T[]>;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  emptyMessage: string;
}

/** A read-only table card with loading, error and empty states. */
function MetricsTableCard<T>({ title, query, columns, rowKey, emptyMessage }: MetricsTableCardProps<T>) {
  const { data, isLoading, error, refetch } = query;

  let body: ReactNode;
  if (isLoading) {
    body = Array.from({ length: 4 }).map((_, i) => (
      <TableRow key={i}>
        <TableCell colSpan={columns.length}>
          <Skeleton className="h-5 w-full" />
        </TableCell>
      </TableRow>
    ));
  } else if (error) {
    body = (
      <TableRow>
        <TableCell colSpan={columns.length}>
          <AnalyticsErrorState message={error.message} onRetry={() => void refetch()} />
        </TableCell>
      </TableRow>
    );
  } else if (!data?.length) {
    body = (
      <TableRow>
        <TableCell colSpan={columns.length}>
          <AnalyticsEmptyState description={emptyMessage} />
        </TableCell>
      </TableRow>
    );
  } else {
    body = data.map((row) => (
      <TableRow key={rowKey(row)}>
        {columns.map((column) => (
          <TableCell key={column.header} className={column.numeric ? 'text-end tabular-nums' : undefined}>
            {column.cell(row)}
          </TableCell>
        ))}
      </TableRow>
    ));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.header} className={column.numeric ? 'text-end' : undefined}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>{body}</TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** `t` is `analytics`'s translator, `tStatus` is `common`'s (reused for the shared "Status" header). */
function apiColumns(t: ReturnType<typeof useTranslations>, tStatus: ReturnType<typeof useTranslations>): Column<AnalyticsApiRow>[] {
  return [
    {
      header: t('table.columns.api'),
      cell: (row) => (
        <>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-muted-foreground">{row.slug}</div>
        </>
      ),
    },
    { header: tStatus('status'), cell: (row) => <Badge variant="outline">{row.status}</Badge> },
    { header: t('table.columns.requests'), numeric: true, cell: (row) => row.requests.toLocaleString() },
    { header: t('table.columns.errors'), numeric: true, cell: (row) => row.errors.toLocaleString() },
    { header: t('table.columns.errorRate'), numeric: true, cell: (row) => formatPercent(row.errorRate) },
    { header: t('table.columns.avgLatency'), numeric: true, cell: (row) => formatMs(row.avgLatencyMs) },
  ];
}

function keyColumns(t: ReturnType<typeof useTranslations>, tStatus: ReturnType<typeof useTranslations>): Column<AnalyticsKeyRow>[] {
  return [
    { header: t('table.columns.key'), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t('table.columns.api'), cell: (row) => row.apiDefName ?? '—' },
    { header: tStatus('status'), cell: (row) => <Badge variant="outline">{row.status}</Badge> },
    { header: t('table.columns.requests'), numeric: true, cell: (row) => row.requests.toLocaleString() },
    { header: t('table.columns.errors'), numeric: true, cell: (row) => row.errors.toLocaleString() },
    { header: t('table.columns.errorRate'), numeric: true, cell: (row) => formatPercent(row.errorRate) },
    { header: t('table.columns.avgLatency'), numeric: true, cell: (row) => formatMs(row.avgLatencyMs) },
  ];
}

function ApiTable({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const query = useAnalyticsApis(range);
  return (
    <MetricsTableCard
      title={t('table.apiTitle')}
      query={query}
      columns={apiColumns(t, tCommon)}
      rowKey={(row) => row.apiDefId}
      emptyMessage={t('table.apiEmpty')}
    />
  );
}

function KeyTable({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const query = useAnalyticsKeys(range);
  return (
    <MetricsTableCard
      title={t('table.keyTitle')}
      query={query}
      columns={keyColumns(t, tCommon)}
      rowKey={(row) => row.apiKeyId}
      emptyMessage={t('table.keyEmpty')}
    />
  );
}

function AnalyticsView() {
  const t = useTranslations('analytics');
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const { data: health } = useAnalyticsHealth();

  const handleRangeChange = (value: string) => {
    const next = ANALYTICS_RANGES.find((option) => option.value === value);
    if (next) setRange(next.value);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Select value={range} onValueChange={handleRangeChange}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t('rangeLabel')}>
            <SelectValue placeholder={t('rangePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {ANALYTICS_RANGES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(`ranges.${option.value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {health && !health.pipelineReady && !isPipelineStale(health) ? (
        // The pump pipeline is not delivering rows: one explanation instead of a wall of empty charts.
        <Card>
          <AnalyticsEmptyState health={health} />
        </Card>
      ) : (
        <>
          {health && isPipelineStale(health) && <AnalyticsStaleNotice health={health} />}
          <OverviewTiles range={range} />
          <div className="grid gap-4 lg:grid-cols-2">
            <RequestsChart range={range} />
            <LatencyChart range={range} />
          </div>
          <StatusCodeChart range={range} />
          <ApiTable range={range} />
          <KeyTable range={range} />
        </>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <PagePermissionGate permission="analytics:read">
      <AnalyticsView />
    </PagePermissionGate>
  );
}
