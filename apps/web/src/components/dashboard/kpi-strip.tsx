'use client';

import { useId } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Clock, Gauge, Server, ShieldCheck, Zap } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Figure } from '@/components/dashboard/figure';
import { KpiTile, KpiTileSkeleton } from '@/components/dashboard/kpi-tile';
import { useAnalyticsOverview } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';
import { usePermissions } from '@/hooks/use-permissions';
import { useNodeHealth } from '@/hooks/use-settings';
import { trafficHref } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';

/** A link inside a tile's hint line: lifted above the tile's own stretched link so both work. */
const HINT_LINK =
  'relative z-10 rounded-sm hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';

const RANGE_SECONDS: Record<AnalyticsRange, number> = {
  '1h': 3600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
};

/**
 * The gateway nodes' tile. Its own component so the nodes are only asked for when it is shown: the
 * health check needs `settings:read`, and a user without it must not trigger a request that is refused.
 */
function NodesKpi() {
  const t = useTranslations('dashboard.kpis');
  const fmt = useFormat();
  const nodes = useNodeHealth();
  const up = nodes.data?.filter((n) => n.health.reachable).length ?? 0;
  const total = nodes.data?.length ?? 0;
  return (
    <KpiTile
      icon={Server}
      label={t('nodes')}
      tone={total === 0 || nodes.isLoading ? 'default' : up === total ? 'good' : 'bad'}
      value={nodes.isLoading ? '—' : total === 0 ? '—' : `${fmt.number(up)}/${fmt.number(total)}`}
      hint={
        total === 0 ? t('nodesNone') : t('nodesHint', { up: fmt.number(up), total: fmt.number(total) })
      }
    />
  );
}

/**
 * The figures the overview card does not show: throughput, the latency tail (P95 / P99), how many
 * APIs and keys are live and whether the gateway nodes answer. Requests, success rate and average
 * latency stay in the overview card, so nothing here repeats them.
 */
export function KpiStrip({
  range,
  showNodes,
  apiId,
}: {
  range: AnalyticsRange;
  showNodes: boolean;
  apiId?: string;
}) {
  const t = useTranslations('dashboard.kpis');
  const headingId = useId();
  const locale = useLocale();
  const fmt = useFormat();
  const overview = useAnalyticsOverview(range, apiId);
  const { can } = usePermissions();
  const data = overview.data;
  const has = (data?.totalRequests ?? 0) > 0;
  // Every figure opens the list that produced it: the throughput and latency tail are the traffic
  // view's own figures, for the same range (and API, when the dashboard is narrowed to one).
  const traffic = trafficHref({ range, apiId });

  const perSecond = data ? data.totalRequests / RANGE_SECONDS[range] : 0;
  const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: perSecond < 10 ? 2 : 0 });
  const tiles = showNodes ? 5 : 4;

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 id={headingId} className="text-lg font-normal tracking-tight">
          {t('title')}
        </h2>
        <Link
          href={traffic}
          className="text-primary inline-flex items-center gap-1 rounded-full text-sm font-medium hover:underline"
        >
          {t('openTraffic')}
          <ArrowUpRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
        </Link>
      </div>
      <div
        className={cn(
          'grid grid-cols-2 gap-3 sm:grid-cols-3',
          tiles === 5 ? 'xl:grid-cols-5' : 'xl:grid-cols-4',
        )}
      >
        {!data ? (
          Array.from({ length: tiles }).map((_, i) => <KpiTileSkeleton key={i} />)
        ) : (
          <>
            <KpiTile
              icon={Zap}
              label={t('throughput')}
              value={has ? rate.format(perSecond) : '—'}
              hint={t('perSecond')}
              href={traffic}
            />
            <KpiTile
              icon={Gauge}
              label={t('p95')}
              value={has ? <Figure value={data.p95LatencyMs} kind="ms" /> : '—'}
              hint={has ? t('p50', { value: fmt.ms(data.p50LatencyMs) }) : undefined}
              href={traffic}
            />
            <KpiTile
              icon={Clock}
              label={t('p99')}
              value={has ? <Figure value={data.p99LatencyMs} kind="ms" /> : '—'}
              hint={t('slowestOnePercent')}
              href={traffic}
            />
            <KpiTile
              icon={ShieldCheck}
              label={t('apis')}
              value={fmt.number(data.activeApis)}
              // Narrowed to one API the count is 1 and the keys are those seen in its traffic: the
              // API's own page, and no key list (which is not filterable by API from here).
              href={can('api:read') ? (apiId ? `/apis/${apiId}` : '/apis') : undefined}
              hint={
                !apiId && can('key:read') ? (
                  <Link href="/keys" className={HINT_LINK}>
                    {t('keys', { count: fmt.number(data.activeKeys) })}
                  </Link>
                ) : (
                  t('keys', { count: fmt.number(data.activeKeys) })
                )
              }
            />
            {showNodes && <NodesKpi />}
          </>
        )}
      </div>
    </section>
  );
}
