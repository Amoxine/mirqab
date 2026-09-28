'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsOverview, useAnalyticsStatusCodes } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';
import { cn } from '@/lib/utils';
import type { AnalyticsRange, AnalyticsStatusCode } from '@/types';
import { Figure } from './figure';

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

function StatusMix({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('dashboard.overview');
  const locale = useLocale();
  const fmt = useFormat();
  const { data, isLoading, error } = useAnalyticsStatusCodes(range);
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
      <div
        className="text-muted-foreground mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.72rem]"
        aria-hidden="true"
      >
        {classes.map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <i className={cn('size-2 rounded-[2px]', CLASS_FILL[c])} />
            {c} <b className="text-foreground font-medium">{pct.format(totals[c] / sum)}</b>
          </span>
        ))}
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

function Stat({ value, label, hint }: { value: React.ReactNode; label: string; hint?: string }) {
  return (
    <div className="min-w-0">
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
export function OverviewPanel({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('dashboard.overview');
  const tRanges = useTranslations('analytics.ranges');
  const fmt = useFormat();
  const { data, isLoading, error, refetch } = useAnalyticsOverview(range);

  return (
    <Card className="surface-ink @container flex flex-1 flex-col rounded-[1.25rem] p-5 sm:p-6">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-normal tracking-tight">{t('title')}</h2>
        <span className="text-muted-foreground truncate font-mono text-[0.68rem] uppercase tracking-[0.08em]">
          {tRanges(range)}
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
            label={t('totalRequests')}
            hint={fmt.number(data.totalRequests)}
          />
          {/* Rates and latency are undefined without traffic: a dash, never a made-up 0. */}
          <Stat
            value={
              data.totalRequests > 0 ? <Figure value={100 - data.errorRate} kind="percent" /> : '—'
            }
            label={t('successRate')}
            hint={t('errors', { count: fmt.number(data.errorCount) })}
          />
          <Stat
            value={data.totalRequests > 0 ? <Figure value={data.avgLatencyMs} kind="ms" /> : '—'}
            label={t('avgLatency')}
            hint={t('activeApis', { count: fmt.number(data.activeApis) })}
          />
        </div>
      )}

      <div className="mt-6 border-t pt-4">
        <div className="text-muted-foreground mb-2.5 text-[0.8rem]">{t('statusMix')}</div>
        <StatusMix range={range} />
      </div>
    </Card>
  );
}
