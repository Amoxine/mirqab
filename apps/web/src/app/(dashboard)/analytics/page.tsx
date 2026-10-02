'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
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
import { ApiStatusBadge } from '@/components/apis/api-status-badge';
import { KpiTile, KpiTileSkeleton } from '@/components/dashboard/kpi-tile';
import { KeyStatusBadge } from '@/components/keys/key-status-badge';
import { PageHeader } from '@/components/shared/page-header';
import { FIGURE_LINK, RowLink, rowLinkProps } from '@/components/shared/row-link';
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
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { usePermissions } from '@/hooks/use-permissions';
import { searchHref, searchToken, trafficHref } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import type { AnalyticsApiRow, AnalyticsKeyRow, AnalyticsRange } from '@/types';
import { useFormat, type Format } from '@/hooks/use-format';

function OverviewTiles({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const fmt = useFormat();
  const { can } = usePermissions();
  const canSearch = useCanSearchRequests();
  const { data, isLoading, error, refetch } = useAnalyticsOverview(range);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <KpiTileSkeleton key={i} />
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
  // Every figure opens the list that produced it: the traffic view, or the failed requests (status
  // 400 and up, which is how errors are counted); the counts open the API and key lists.
  const traffic = trafficHref({ range });
  const failed = canSearch ? searchHref(['status:>=400'], range) : undefined;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiTile
        label={t('overview.totalRequests')}
        value={fmt.number(data.totalRequests)}
        icon={Activity}
        href={traffic}
      />
      <KpiTile
        label={t('table.columns.errorRate')}
        value={hasTraffic ? fmt.percent(data.errorRate) : '—'}
        icon={CheckCircle}
        hint={t('overview.successCount', { count: fmt.number(data.successCount) })}
        href={failed}
      />
      <KpiTile
        label={t('table.columns.avgLatency')}
        value={hasTraffic ? fmt.ms(data.avgLatencyMs) : '—'}
        icon={Clock}
        hint={
          hasTraffic
            ? t('overview.upstreamLatency', { value: fmt.ms(data.avgUpstreamLatencyMs) })
            : undefined
        }
        href={traffic}
      />
      <KpiTile
        label={t('table.columns.errors')}
        value={fmt.number(data.errorCount)}
        icon={AlertTriangle}
        href={failed}
      />
      <KpiTile
        label={t('overview.activeApis')}
        value={fmt.number(data.activeApis)}
        icon={ShieldCheck}
        href={can('api:read') ? '/apis' : undefined}
      />
      <KpiTile
        label={t('overview.activeKeys')}
        value={fmt.number(data.activeKeys)}
        icon={KeyRound}
        href={can('key:read') ? '/keys' : undefined}
      />
    </div>
  );
}

interface Column<T> {
  header: string;
  numeric?: boolean;
  cell: (row: T) => ReactNode;
}

/** The row's hover pill starts at its first cell, which is a `th` here (the table's own rule names a `td`). */
const ROW_HEADER_PILL = '[&>th:first-child]:rounded-s-xl';

/** What a table's cells link to and what the user may open: the same for every row. */
interface RowLinks {
  range: AnalyticsRange;
  /** Request search is open to this user (the failed-request links). */
  canSearch: boolean;
  /** The row's API / key has a detail page this user may open. */
  canOpenDetail: boolean;
  /** Names that more than one key has (keys only): a `key:` search clause matches a key by its name. */
  sharedKeyNames?: ReadonlySet<string>;
}

/** The names that more than one of `rows` has. */
function sharedNames(rows: readonly { name: string }[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of rows) {
    if (seen.has(name)) shared.add(name);
    seen.add(name);
  }
  return shared;
}

interface MetricsTableCardProps<T> {
  title: string;
  query: UseQueryResult<T[]>;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Where a row leads (the traffic behind it). The whole row opens it for a pointer; the row's own links stay the keyboard's way in. */
  rowHref?: (row: T) => string;
  emptyMessage: string;
}

/** A table card with loading, error and empty states; its rows open the traffic behind them. */
function MetricsTableCard<T>({
  title,
  query,
  columns,
  rowKey,
  rowHref,
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
    body = data.map((row) => {
      const href = rowHref?.(row);
      return (
        <TableRow
          key={rowKey(row)}
          {...(href ? rowLinkProps(ROW_HEADER_PILL) : { className: ROW_HEADER_PILL })}
        >
          {columns.map((column, index) =>
            index === 0 ? (
              // The first column names the row (the API, the key): a row header, so every figure in the
              // row is read with it.
              <th key={column.header} scope="row" className="px-3 py-2 text-start align-middle font-normal">
                {href ? <RowLink href={href} /> : null}
                {column.cell(row)}
              </th>
            ) : (
              <TableCell
                key={column.header}
                className={column.numeric ? 'text-end tabular-nums' : undefined}
              >
                {column.cell(row)}
              </TableCell>
            ),
          )}
        </TableRow>
      );
    });
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
  links: RowLinks,
): Column<AnalyticsApiRow>[] {
  return [
    {
      header: t('table.columns.api'),
      cell: (row) => (
        <>
          {links.canOpenDetail ? (
            <Link href={`/apis/${row.apiDefId}`} className={cn(FIGURE_LINK, 'font-medium')}>
              {row.name}
            </Link>
          ) : (
            <div className="font-medium">{row.name}</div>
          )}
          <div className="text-muted-foreground font-mono text-xs">{row.slug}</div>
        </>
      ),
    },
    { header: tStatus('status'), cell: (row) => <ApiStatusBadge status={row.status} /> },
    {
      header: t('table.columns.requests'),
      numeric: true,
      cell: (row) => (
        <Link href={trafficHref({ range: links.range, apiId: row.apiDefId })} className={FIGURE_LINK}>
          <span className="sr-only">{t('table.viewTraffic', { name: row.name })}</span> {fmt.number(row.requests)}
        </Link>
      ),
    },
    {
      header: t('table.columns.errors'),
      numeric: true,
      cell: (row) =>
        links.canSearch && row.errors > 0 ? (
          <Link
            href={searchHref([searchToken('api', row.apiDefId), 'status:>=400'], links.range)}
            className={FIGURE_LINK}
          >
            <span className="sr-only">{t('table.viewFailed', { name: row.name })}</span> {fmt.number(row.errors)}
          </Link>
        ) : (
          fmt.number(row.errors)
        ),
    },
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

function keyColumns(
  t: ReturnType<typeof useTranslations>,
  tStatus: ReturnType<typeof useTranslations>,
  fmt: Format,
  links: RowLinks,
): Column<AnalyticsKeyRow>[] {
  return [
    {
      header: t('table.columns.key'),
      cell: (row) =>
        links.canOpenDetail ? (
          <Link href={`/keys/${row.apiKeyId}`} className={cn(FIGURE_LINK, 'font-medium')}>
            {row.name}
          </Link>
        ) : (
          <span className="font-medium">{row.name}</span>
        ),
    },
    { header: t('table.columns.api'), cell: (row) => row.apiDefName ?? '—' },
    { header: tStatus('status'), cell: (row) => <KeyStatusBadge status={row.status} /> },
    {
      header: t('table.columns.requests'),
      numeric: true,
      cell: (row) => (
        <Link href={trafficHref({ range: links.range, keyId: row.apiKeyId })} className={FIGURE_LINK}>
          <span className="sr-only">{t('table.viewTraffic', { name: row.name })}</span> {fmt.number(row.requests)}
        </Link>
      ),
    },
    {
      header: t('table.columns.errors'),
      numeric: true,
      // The search names a key by its name (its alias on the gateway), which may not be writable, and
      // which another key may share: that search would list both keys' failures, so there is no link.
      cell: (row) => {
        const keyToken = searchToken('key', row.name);
        return links.canSearch && row.errors > 0 && keyToken !== null && !links.sharedKeyNames?.has(row.name) ? (
          <Link href={searchHref([keyToken, 'status:>=400'], links.range)} className={FIGURE_LINK}>
            <span className="sr-only">{t('table.viewFailed', { name: row.name })}</span> {fmt.number(row.errors)}
          </Link>
        ) : (
          fmt.number(row.errors)
        );
      },
    },
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
  const { can } = usePermissions();
  const canSearch = useCanSearchRequests();
  const query = useAnalyticsApis(range);
  return (
    <MetricsTableCard
      title={t('table.apiTitle')}
      query={query}
      columns={apiColumns(t, tCommon, fmt, { range, canSearch, canOpenDetail: can('api:read') })}
      rowKey={(row) => row.apiDefId}
      rowHref={(row) => trafficHref({ range, apiId: row.apiDefId })}
      emptyMessage={t('table.apiEmpty')}
    />
  );
}

function KeyTable({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const { can } = usePermissions();
  const canSearch = useCanSearchRequests();
  const query = useAnalyticsKeys(range);
  return (
    <MetricsTableCard
      title={t('table.keyTitle')}
      query={query}
      columns={keyColumns(t, tCommon, fmt, {
        range,
        canSearch,
        canOpenDetail: can('key:read'),
        sharedKeyNames: sharedNames(query.data ?? []),
      })}
      rowKey={(row) => row.apiKeyId}
      rowHref={(row) => trafficHref({ range, keyId: row.apiKeyId })}
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
