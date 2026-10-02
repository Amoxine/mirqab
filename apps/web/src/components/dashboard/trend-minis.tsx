'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsOverview, useAnalyticsTimeSeries } from '@/hooks/use-analytics';
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { useFormat } from '@/hooks/use-format';
import { searchHref, searchToken, trafficHref } from '@/lib/traffic-filters-to-query';
import type { AnalyticsRange } from '@/types';
import { Figure } from './figure';
import { Sparkline } from './sparkline';
import { bucketErrorRate } from './viz-utils';

/** `href` is the list behind the figure; `linkLabel` names it when it is not simply "the analytics for this card". */
function MiniShell({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  const tCommon = useTranslations('dashboard.page');
  return (
    <Card className="bg-card/85 flex flex-col gap-2.5 rounded-[1.25rem] p-4 backdrop-blur-md">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[0.95rem] font-normal">{title}</h3>
        <Link
          href={href}
          aria-label={linkLabel ?? tCommon('openAnalytics', { title })}
          className="bg-foreground text-card grid size-8 shrink-0 place-items-center rounded-full transition-transform duration-300 hover:rotate-45 rtl:-scale-x-100"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
      {children}
    </Card>
  );
}

function MiniSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

/** Average latency, split into time spent upstream and the gateway's own overhead. */
export function LatencyMini({ range, apiId }: { range: AnalyticsRange; apiId?: string }) {
  const t = useTranslations('dashboard.latency');
  const fmt = useFormat();
  const overview = useAnalyticsOverview(range, apiId);
  const series = useAnalyticsTimeSeries('requests', range, apiId);
  const data = overview.data;

  let body: React.ReactNode;
  if (overview.isLoading) body = <MiniSkeleton />;
  else if (!data || data.totalRequests === 0)
    body = <p className="text-muted-foreground py-4 text-sm">{t('empty')}</p>;
  else {
    const upstream = Math.min(data.avgUpstreamLatencyMs, data.avgLatencyMs);
    const overhead = Math.max(0, data.avgLatencyMs - upstream);
    const trend = (series.data ?? []).filter((p) => p.requests > 0).map((p) => p.avgLatencyMs);
    body = (
      <>
        <div className="flex items-baseline gap-1.5">
          <Figure
            value={data.avgLatencyMs}
            kind="ms"
            className="text-[1.75rem] font-light leading-none tracking-[-0.04em]"
          />
          <span className="text-muted-foreground font-mono text-[0.68rem]">{t('average')}</span>
        </div>
        {trend.length > 1 ? <Sparkline values={trend} /> : <div className="h-11" />}
        {/* Where the time goes: upstream service vs. the gateway itself. */}
        <div>
          <div className="flex h-1.5 gap-0.5" dir="ltr" aria-hidden="true">
            <span className="bg-primary/45 rounded-s-full" style={{ flexGrow: upstream || 1 }} />
            <span
              className="bg-primary min-w-[3px] rounded-e-full"
              style={{ flexGrow: overhead }}
            />
          </div>
          <p className="text-muted-foreground mt-1.5 font-mono text-[0.68rem]">
            {t('split', { upstream: fmt.ms(upstream), overhead: fmt.ms(overhead) })}
          </p>
        </div>
      </>
    );
  }
  return (
    <MiniShell title={t('title')} href={trafficHref({ range, apiId })}>
      {body}
    </MiniShell>
  );
}

/** Error rate for the range with its per-bucket trend. */
export function ErrorsMini({ range, apiId }: { range: AnalyticsRange; apiId?: string }) {
  const t = useTranslations('dashboard.errors');
  const fmt = useFormat();
  const canSearch = useCanSearchRequests();
  const overview = useAnalyticsOverview(range, apiId);
  const series = useAnalyticsTimeSeries('requests', range, apiId);
  const data = overview.data;

  let body: React.ReactNode;
  if (overview.isLoading) body = <MiniSkeleton />;
  else if (!data || data.totalRequests === 0)
    body = <p className="text-muted-foreground py-4 text-sm">{t('empty')}</p>;
  else {
    const trend = (series.data ?? []).map(bucketErrorRate).filter((v): v is number => v !== null);
    const peak = trend.length ? Math.max(...trend) : null;
    body = (
      <>
        <div className="flex items-baseline gap-1.5">
          <Figure
            value={data.errorRate}
            kind="percent"
            className="text-[1.75rem] font-light leading-none tracking-[-0.04em]"
          />
          <span className="text-muted-foreground font-mono text-[0.68rem]">{t('ofRequests')}</span>
        </div>
        {trend.length > 1 ? <Sparkline values={trend} area /> : <div className="h-11" />}
        <p
          className={data.errorCount > 0 ? 'text-warning text-xs' : 'text-muted-foreground text-xs'}
        >
          {data.errorCount > 0
            ? t('summary', {
                count: fmt.number(data.errorCount),
                peak: peak === null ? '—' : fmt.percent(peak),
              })
            : t('none')}
        </p>
      </>
    );
  }
  // The failed requests themselves (status 400 and up, how errors are counted) for someone who may
  // search; the traffic view for the same range otherwise.
  return canSearch ? (
    <MiniShell
      title={t('title')}
      href={searchHref([apiId ? searchToken('api', apiId) : null, 'status:>=400'], range)}
      linkLabel={t('openFailed')}
    >
      {body}
    </MiniShell>
  ) : (
    <MiniShell title={t('title')} href={trafficHref({ range, apiId })}>
      {body}
    </MiniShell>
  );
}
