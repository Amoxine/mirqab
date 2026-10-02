'use client';

import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { StretchedLink } from '@/components/shared/row-link';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsOverview, useAnalyticsStatusCodes } from '@/hooks/use-analytics';
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { useFormat } from '@/hooks/use-format';
import { searchHref, searchToken, trafficHref } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import type { AnalyticsRange, AnalyticsStatusCode } from '@/types';
import { Figure } from './figure';
import { ScopeTag } from './scope-tag';

type StatusClass = '2xx' | '4xx' | '5xx';

/** Colour by what the class means: success recedes (neutral), client errors warn, server errors alarm. */
const CLASS_FILL: Record<StatusClass, string> = {
  '2xx': 'bg-foreground/35',
  '4xx': 'bg-warning',
  '5xx': 'bg-destructive',
};

function summarise(codes: AnalyticsStatusCode[]) {
  const totals: Record<StatusClass, number> = { '2xx': 0, '4xx': 0, '5xx': 0 };
  let topError: AnalyticsStatusCode | null = null;
  for (const entry of codes) {
    const cls: StatusClass = entry.code.startsWith('5')
      ? '5xx'
      : entry.code.startsWith('4')
        ? '4xx'
        : '2xx';
    totals[cls] += entry.count;
    // A specific code (401, 503…) is more useful than the '4xx' / '5xx' remainder buckets.
    if (cls !== '2xx' && /^\d{3}$/.test(entry.code) && (!topError || entry.count > topError.count))
      topError = entry;
  }
  const sum = totals['2xx'] + totals['4xx'] + totals['5xx'];
  return { totals, sum, topError };
}

function StatusMix({
  range,
  apiId,
  classHref,
}: {
  range: AnalyticsRange;
  apiId?: string;
  /** Where one class's share leads; omitted when the user cannot open it. */
  classHref?: (cls: StatusClass) => string;
}) {
  const t = useTranslations('dashboard.overview');
  const locale = useLocale();
  const fmt = useFormat();
  const { data, isLoading, error } = useAnalyticsStatusCodes(range, apiId);
  const pct = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }),
    [locale],
  );

  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (error || !data)
    return <p className="text-muted-foreground text-sm">{t('statusMixUnavailable')}</p>;

  const { totals, sum, topError } = summarise(data);
  if (sum === 0) return <p className="text-muted-foreground text-sm">{t('statusMixEmpty')}</p>;

  const classes = (Object.keys(totals) as StatusClass[]).filter((c) => totals[c] > 0);
  const label = classes.map((c) => `${c} ${pct.format(totals[c] / sum)}`).join(', ');

  return (
    <div>
      {/* 2px surface gaps between segments; a sliver of 5xx still shows (min width) and its exact share is in the legend. */}
      <div
        className="flex h-2 gap-0.5"
        role="img"
        aria-label={t('statusMixLabel', { breakdown: label })}
        dir="ltr"
      >
        {classes.map((c, i) => (
          <span
            key={c}
            className={cn(
              'min-w-[3px] transition-[flex-grow] duration-500',
              CLASS_FILL[c],
              i === 0 && 'rounded-s-full',
              i === classes.length - 1 && 'rounded-e-full',
            )}
            style={{ flexGrow: totals[c] }}
          />
        ))}
      </div>
      {/* Hidden from assistive tech (the bar above says it all) unless the shares are links, which must stay reachable. */}
      <div
        className="text-muted-foreground mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.72rem]"
        aria-hidden={classHref ? undefined : true}
      >
        {classes.map((c) => {
          const share = (
            <>
              <i className={cn('size-2 rounded-[2px]', CLASS_FILL[c])} />
              {c} <b className="text-foreground font-medium">{pct.format(totals[c] / sum)}</b>
            </>
          );
          return classHref ? (
            <Link
              key={c}
              href={classHref(c)}
              className="inline-flex items-center gap-1.5 rounded-sm hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* What the link is for, then the class and its share (the visible text). */}
              <span className="sr-only">{t('viewStatus')}</span>{' '}
              {share}
            </Link>
          ) : (
            <span key={c} className="inline-flex items-center gap-1.5">
              {share}
            </span>
          );
        })}
      </div>
      {topError && (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('topError', {
            code: topError.code,
            count: fmt.number(topError.count),
            compact: formatCount(topError.count, locale),
          })}
        </p>
      )}
    </div>
  );
}

/** A text, made the name of a link that covers the whole stat when it leads somewhere. */
function Linked({ href, children }: { href?: string; children: ReactNode }) {
  return href ? <StretchedLink href={href}>{children}</StretchedLink> : <>{children}</>;
}

function Stat({ value, label, hint }: { value: ReactNode; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className="relative min-w-0">
      {/* Proportional figures at display size; container units keep three across without overflow. */}
      <div className="text-[clamp(1.3rem,calc((100cqi-2rem)/10),2.2rem)] font-light leading-none tracking-[-0.045em]">
        {value}
      </div>
      <div className="text-muted-foreground mt-2 text-[0.8rem]">{label}</div>
      {hint && <div className="text-muted-foreground mt-0.5 font-mono text-[0.68rem]">{hint}</div>}
    </div>
  );
}

/** Headline figures for the range plus the HTTP status mix, on the dark emphasis surface. */
export function OverviewPanel({
  range,
  scope,
}: {
  range: AnalyticsRange;
  /** The API the figures are narrowed to; the gateway-wide view when omitted. */
  scope?: { id: string; name: string } | null;
}) {
  const t = useTranslations('dashboard.overview');
  const tRanges = useTranslations('analytics.ranges');
  const fmt = useFormat();
  const { data, isLoading, error, refetch } = useAnalyticsOverview(range, scope?.id);
  const canSearch = useCanSearchRequests();
  // Each figure opens the list behind it. Errors are counted as status 400 and up (the API's own
  // definition), so that is the search; a status class's share is that class.
  const traffic = trafficHref({ range, apiId: scope?.id });
  const searchFor = (status: string) =>
    searchHref([scope ? searchToken('api', scope.id) : null, `status:${status}`], range);

  return (
    <Card variant="ink" className="@container flex flex-1 flex-col p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-normal tracking-tight">{t('title')}</h2>
        <span className="flex min-w-0 items-center gap-2">
          <ScopeTag name={scope?.name} />
          <span className="text-muted-foreground truncate font-mono text-[0.68rem] uppercase tracking-[0.08em]">
            {tRanges(range)}
          </span>
        </span>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-4" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      ) : error || !data ? (
        <AnalyticsErrorState
          message={error?.message ?? t('unavailable')}
          onRetry={() => void refetch()}
        />
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Stat
            value={<Figure value={data.totalRequests} kind="compact" />}
            label={<Linked href={traffic}>{t('totalRequests')}</Linked>}
            hint={fmt.number(data.totalRequests)}
          />
          {/* Rates and latency are undefined without traffic: a dash, never a made-up 0. */}
          <Stat
            value={
              data.totalRequests > 0 ? <Figure value={100 - data.errorRate} kind="percent" /> : '—'
            }
            label={t('successRate')}
            // The error count is what links, so that is the link's name: "1,000 errors", not "Success rate".
            hint={
              <Linked href={canSearch && data.errorCount > 0 ? searchFor('>=400') : undefined}>
                {t('errors', { count: fmt.number(data.errorCount) })}
              </Linked>
            }
          />
          <Stat
            value={data.totalRequests > 0 ? <Figure value={data.avgLatencyMs} kind="ms" /> : '—'}
            label={<Linked href={traffic}>{t('avgLatency')}</Linked>}
            hint={t('activeApis', { count: fmt.number(data.activeApis) })}
          />
        </div>
      )}

      <div className="mt-4 border-t pt-3">
        <div className="text-muted-foreground mb-2.5 text-[0.8rem]">{t('statusMix')}</div>
        <StatusMix
          range={range}
          apiId={scope?.id}
          classHref={canSearch ? searchFor : undefined}
        />
      </div>
    </Card>
  );
}
