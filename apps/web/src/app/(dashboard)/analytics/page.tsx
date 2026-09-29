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
} from '@/components/analytics/analytics-empty-state';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { LatencyChart } from '@/components/analytics/latency-chart';
import { RequestsChart } from '@/components/analytics/requests-chart';
import { StatusCodeChart } from '@/components/analytics/status-code-chart';
import { Badge } from '@/components/ui/badge';
import { ApiStatusBadge } from '@/components/apis/api-status-badge';
import { StatCard, StatCardSkeleton } from '@/components/dashboard/stat-card';
import { keyStatusVariant } from '@/components/keys/key-utils';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RangeControl } from '@/components/dashboard/range-control';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAnalyticsApis,
  useAnalyticsHealth,
  useAnalyticsKeys,
  useAnalyticsOverview,
} from '@/hooks/use-analytics';
import type { AnalyticsApiRow, AnalyticsKeyRow, AnalyticsRange } from '@/types';
import { useFormat, type Format } from '@/hooks/use-format';

function OverviewTiles({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const fmt = useFormat();
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
        <AnalyticsErrorState
          message={error?.message ?? t('noData')}
          onRetry={() => void refetch()}
        />
      </Card>
    );
  }

  // Rates and latencies are undefined without traffic: show a dash rather than a made-up 0.
  const hasTraffic = data.totalRequests > 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard
        title={t('overview.totalRequests')}
        value={fmt.number(data.totalRequests)}
        icon={Activity}
      />
      <StatCard
        title={t('table.columns.errorRate')}
        value={hasTraffic ? fmt.percent(data.errorRate) : '—'}
        icon={CheckCircle}
        description={t('overview.successCount', { count: fmt.number(data.successCount) })}
      />
      <StatCard
        title={t('table.columns.avgLatency')}
        value={hasTraffic ? fmt.ms(data.avgLatencyMs) : '—'}
        icon={Clock}
        description={
          hasTraffic
            ? t('overview.upstreamLatency', { value: fmt.ms(data.avgUpstreamLatencyMs) })
            : undefined
        }
      />
      <StatCard
        title={t('table.columns.errors')}
        value={fmt.number(data.errorCount)}
        icon={AlertTriangle}
      />
      <StatCard
        title={t('overview.activeApis')}
        value={fmt.number(data.activeApis)}
        icon={ShieldCheck}
      />
      <StatCard
        title={t('overview.activeKeys')}
        value={fmt.number(data.activeKeys)}
        icon={KeyRound}
      />
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
function MetricsTableCard<T>({
  title,
  query,
  columns,
  rowKey,
  emptyMessage,
}: MetricsTableCardProps<T>) {
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
          <TableCell
            key={column.header}
            className={column.numeric ? 'text-end tabular-nums' : undefined}
          >
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
      <CardContent className="w-0 min-w-full">
        {/* A metrics table keeps its columns aligned for comparison; it scrolls inside the card on phones. */}
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
function apiColumns(
  t: ReturnType<typeof useTranslations>,
  tStatus: ReturnType<typeof useTranslations>,
  fmt: Format,
): Column<AnalyticsApiRow>[] {
  return [
    {
      header: t('table.columns.api'),
      cell: (row) => (
        <>
          <div className="font-medium">{row.name}</div>
          <div className="text-muted-foreground font-mono text-xs">{row.slug}</div>
        </>
      ),
    },
    { header: tStatus('status'), cell: (row) => <ApiStatusBadge status={row.status} /> },
    { header: t('table.columns.requests'), numeric: true, cell: (row) => fmt.number(row.requests) },
    { header: t('table.columns.errors'), numeric: true, cell: (row) => fmt.number(row.errors) },
    {
      header: t('table.columns.errorRate'),
      numeric: true,
      cell: (row) => fmt.percent(row.errorRate),
    },
    {
      header: t('table.columns.avgLatency'),
      numeric: true,
      cell: (row) => fmt.ms(row.avgLatencyMs),
    },
  ];
}

/** Same variant and label as the keys page, instead of the raw enum code. */
function KeyStatus({ status }: { status: AnalyticsKeyRow['status'] }) {
  const t = useTranslations('keys');
  return <Badge variant={keyStatusVariant(status)}>{t(`status.${status}`)}</Badge>;
}

function keyColumns(
  t: ReturnType<typeof useTranslations>,
  tStatus: ReturnType<typeof useTranslations>,
  fmt: Format,
): Column<AnalyticsKeyRow>[] {
  return [
    {
      header: t('table.columns.key'),
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { header: t('table.columns.api'), cell: (row) => row.apiDefName ?? '—' },
    { header: tStatus('status'), cell: (row) => <KeyStatus status={row.status} /> },
    { header: t('table.columns.requests'), numeric: true, cell: (row) => fmt.number(row.requests) },
    { header: t('table.columns.errors'), numeric: true, cell: (row) => fmt.number(row.errors) },
    {
      header: t('table.columns.errorRate'),
      numeric: true,
      cell: (row) => fmt.percent(row.errorRate),
    },
    {
      header: t('table.columns.avgLatency'),
      numeric: true,
      cell: (row) => fmt.ms(row.avgLatencyMs),
    },
  ];
}

function ApiTable({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const query = useAnalyticsApis(range);
  return (
    <MetricsTableCard
      title={t('table.apiTitle')}
      query={query}
      columns={apiColumns(t, tCommon, fmt)}
      rowKey={(row) => row.apiDefId}
      emptyMessage={t('table.apiEmpty')}
    />
  );
}

function KeyTable({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const query = useAnalyticsKeys(range);
  return (
    <MetricsTableCard
      title={t('table.keyTitle')}
      query={query}
      columns={keyColumns(t, tCommon, fmt)}
      rowKey={(row) => row.apiKeyId}
      emptyMessage={t('table.keyEmpty')}
    />
  );
}

function AnalyticsView() {
  const t = useTranslations('analytics');
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const { data: health } = useAnalyticsHealth();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={<RangeControl value={range} onChange={setRange} />}
      />

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
