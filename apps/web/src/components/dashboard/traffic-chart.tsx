'use client';

import { useState } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AnalyticsErrorState,
  formatBucket,
  formatCount,
} from '@/components/analytics/analytics-empty-state';
import { StateMessage } from '@/components/shared/state-card';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsTimeSeries } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';
import { cn } from '@/lib/utils';
import type { AnalyticsRange, AnalyticsTimeSeriesPoint } from '@/types';
import { Figure } from './figure';
import {
  bucketErrorRate,
  columnPath,
  fx,
  niceTicks,
  useElementWidth,
  usePrefersReducedMotion,
} from './viz-utils';

const PAD_START = 46;
const PAD_END = 6;
const TOP = 26;
const COL_H = 136;
const GAP = 26;
const STRIP_H = 44;
const AXIS_H = 22;
const HEIGHT = TOP + COL_H + GAP + STRIP_H + AXIS_H;

interface PlotProps {
  points: AnalyticsTimeSeriesPoint[];
  range: AnalyticsRange;
}

/**
 * Requests as columns and the error rate as a separate strip underneath — two plots sharing one time
 * axis, never two scales on one plot. Hover or arrow keys read every series at a bucket.
 */
function Plot({ points, range }: PlotProps) {
  const t = useTranslations('dashboard.trafficChart');
  const locale = useLocale();
  const fmt = useFormat();
  const reduced = usePrefersReducedMotion();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState(-1);
  const [announce, setAnnounce] = useState('');

  const n = points.length;
  const plotW = Math.max(0, width - PAD_START - PAD_END);
  const band = n ? plotW / n : 0;
  const barW = Math.max(2, Math.min(24, band - 2));
  const requests = points.map((p) => p.requests);
  const rates = points.map(bucketErrorRate);
  const { top: vmax, ticks } = niceTicks(Math.max(...requests, 0), 3);
  const { top: emax, ticks: eticks } = niceTicks(Math.max(...rates.map((r) => r ?? 0), 0.1), 1);
  const base = TOP + COL_H;
  const sTop = base + GAP;
  const sBase = sTop + STRIP_H;
  const yv = (v: number) => base - (v / vmax) * COL_H;
  const ye = (v: number) => sBase - (v / emax) * STRIP_H;
  const cx = (i: number) => PAD_START + band * (i + 0.5);

  const errorLine = rates
    .map((r, i) => (r === null ? null : `${fx(cx(i))},${fx(ye(r))}`))
    .reduce(
      (d: string, pt: string | null, i, all) =>
        pt === null ? d : `${d}${d && all[i - 1] !== null ? 'L' : 'M'}${pt}`,
      '',
    );
  const peakIndex = requests.indexOf(Math.max(...requests));
  const every = Math.max(1, Math.ceil(n / 6));

  const describe = (i: number) =>
    t('readout', {
      time: formatBucket(points[i]?.bucket ?? '', range, true, locale),
      requests: fmt.number(requests[i] ?? 0),
      rate: rates[i] === null ? '—' : fmt.percent(rates[i] ?? 0),
    });

  const select = (i: number, speak: boolean) => {
    setActive(i);
    if (speak && i >= 0) setAnnounce(describe(i));
  };

  const activePoint = active >= 0 ? points[active] : undefined;

  return (
    <div
      ref={ref}
      dir="ltr"
      tabIndex={0}
      role="group"
      aria-roledescription={t('roleDescription')}
      aria-label={t('ariaLabel')}
      className="relative mx-4 mt-3 touch-pan-y rounded-xl outline-offset-4"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const i = Math.floor((e.clientX - rect.left - PAD_START) / band);
        select(i >= 0 && i < n ? i : -1, false);
      }}
      onPointerLeave={(e) => {
        if (document.activeElement !== e.currentTarget) select(-1, false);
      }}
      onFocus={(e) => {
        if (active < 0 && e.currentTarget.matches(':focus-visible')) select(n - 1, true);
      }}
      onBlur={() => {
        select(-1, false);
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (step) {
          e.preventDefault();
          select(Math.min(n - 1, Math.max(0, (active < 0 ? n - 1 : active) + step)), true);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          select(e.key === 'Home' ? 0 : n - 1, true);
        }
      }}
    >
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${fx(width)} ${String(HEIGHT)}`}
          className="block overflow-visible font-mono text-[10px]"
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <g key={`v${String(tick)}`}>
              <line
                x1={PAD_START}
                x2={width - PAD_END}
                y1={yv(tick)}
                y2={yv(tick)}
                stroke="var(--color-border)"
              />
              <text
                x={PAD_START - 8}
                y={yv(tick) + 3.5}
                textAnchor="end"
                fill="var(--color-muted-foreground)"
              >
                {formatCount(tick, locale)}
              </text>
            </g>
          ))}
          <g
            key={`${range}-${String(n)}`}
            className={reduced ? undefined : 'motion-grow'}
            style={{ transformOrigin: `0 ${String(base)}px` }}
          >
            {points.map((p, i) => (
              <path
                key={p.bucket}
                d={columnPath(cx(i) - barW / 2, yv(p.requests), barW, base)}
                fill="var(--color-primary)"
                // The current bucket is emphasised; the rest recede, and recede further while one is read.
                opacity={active >= 0 ? (i === active ? 1 : 0.3) : i === n - 1 ? 1 : 0.55}
                className="transition-opacity duration-150"
              />
            ))}
          </g>

          <text x={PAD_START} y={sTop - 9} fill="var(--color-muted-foreground)">
            {t('errorStrip')}
          </text>
          {eticks.map((tick) => (
            <g key={`e${String(tick)}`}>
              <line
                x1={PAD_START}
                x2={width - PAD_END}
                y1={ye(tick)}
                y2={ye(tick)}
                stroke="var(--color-border)"
              />
              <text
                x={PAD_START - 8}
                y={ye(tick) + 3.5}
                textAnchor="end"
                fill="var(--color-muted-foreground)"
              >
                {tick === 0 ? '0' : fmt.percent(tick)}
              </text>
            </g>
          ))}
          {errorLine && (
            <path
              d={errorLine}
              fill="none"
              stroke="var(--color-destructive)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {points.map((p, i) => {
            const isLast = i === n - 1;
            if (!isLast && (i % every !== 0 || n - 1 - i < every)) return null;
            return (
              <text
                key={`x${p.bucket}`}
                x={cx(i)}
                y={HEIGHT - 5}
                textAnchor={i === 0 ? 'start' : isLast ? 'end' : 'middle'}
                fill="var(--color-muted-foreground)"
              >
                {formatBucket(p.bucket, range, false, locale)}
              </text>
            );
          })}

          {activePoint && (
            <>
              <line
                x1={cx(active)}
                x2={cx(active)}
                y1={TOP - 6}
                y2={sBase}
                stroke="var(--color-foreground)"
                strokeOpacity={0.35}
              />
              {rates[active] !== null && (
                <circle
                  cx={cx(active)}
                  cy={ye(rates[active] ?? 0)}
                  r={4}
                  fill="var(--color-destructive)"
                  stroke="var(--color-card)"
                  strokeWidth={2}
                />
              )}
            </>
          )}
        </svg>
      )}

      {/* Peak callout, hidden while a bucket is being read. */}
      {width > 0 && n > 1 && peakIndex >= 0 && active < 0 && (
        <span
          className="bg-primary text-primary-foreground pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-full px-2.5 py-0.5 font-mono text-[0.66rem] font-medium"
          style={{
            left: Math.min(Math.max(cx(peakIndex), 40), width - 40),
            top: yv(requests[peakIndex] ?? 0) - 6,
          }}
        >
          {t('peak', { value: formatCount(requests[peakIndex] ?? 0, locale) })}
        </span>
      )}

      {activePoint && (
        <div
          // A light popover inside the dark card: its text takes the popover ink, not the card's re-pointed tokens.
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 min-w-44 rounded-xl border border-black/10 px-3 py-2 text-xs shadow-lg dark:border-white/10"
          style={{
            left: cx(active) + 180 > width ? cx(active) - 190 : cx(active) + 14,
            top: Math.max(0, yv(activePoint.requests) - 36),
          }}
        >
          <div className="text-popover-foreground/65 mb-1.5 font-mono text-[0.66rem]">
            {formatBucket(activePoint.bucket, range, true, locale)}
          </div>
          <div className="flex items-center gap-2">
            <i className="bg-primary size-2 rounded-[2px]" />
            <span className="text-popover-foreground/65">{t('requests')}</span>
            <b className="ms-auto font-semibold tabular-nums">{fmt.number(activePoint.requests)}</b>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <i className="bg-destructive h-0.5 w-3 rounded-full" />
            <span className="text-popover-foreground/65">{t('errorRate')}</span>
            <b className="ms-auto font-semibold tabular-nums">
              {rates[active] === null ? '—' : fmt.percent(rates[active] ?? 0)}
            </b>
          </div>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

function DataTable({ points, range }: PlotProps) {
  const t = useTranslations('dashboard.trafficChart');
  const locale = useLocale();
  const fmt = useFormat();
  return (
    <div className="mx-4 mt-3 max-h-72 overflow-auto rounded-xl">
      <table className="w-full text-sm tabular-nums">
        <thead className="bg-card text-muted-foreground sticky top-0 font-mono text-[0.68rem] uppercase tracking-[0.08em]">
          <tr>
            <th scope="col" className="px-3 py-2 text-start font-normal">
              {t('bucket')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-normal">
              {t('requests')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-normal">
              {t('errorRate')}
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const rate = bucketErrorRate(p);
            return (
              <tr key={p.bucket} className="border-t">
                <td className="px-3 py-1.5">{formatBucket(p.bucket, range, true, locale)}</td>
                <td className="px-3 py-1.5 text-end">{fmt.number(p.requests)}</td>
                <td className="px-3 py-1.5 text-end">{rate === null ? '—' : fmt.percent(rate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Request volume over the range (UTC buckets) with its error-rate strip; chart or table view. */
export function TrafficChart({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('dashboard.trafficChart');
  const { data, isLoading, error, refetch } = useAnalyticsTimeSeries('requests', range);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const total = (data ?? []).reduce((sum, p) => sum + p.requests, 0);

  return (
    <Card className="surface-ink overflow-hidden rounded-[1.25rem] pb-4">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-6">
        <div>
          <h2 className="text-lg font-normal tracking-tight">{t('title')}</h2>
          <p className="text-muted-foreground mt-0.5 text-sm">{t('description')}</p>
        </div>
        <div
          role="group"
          aria-label={t('viewLabel')}
          className="bg-muted inline-flex gap-0.5 rounded-full p-1"
        >
          {(['chart', 'table'] as const).map((v) => {
            const Icon = v === 'chart' ? BarChart3 : Table2;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                aria-label={v === 'chart' ? t('chartView') : t('tableView')}
                onClick={() => {
                  setView(v);
                }}
                className={cn(
                  'pointer-coarse:min-h-11 grid h-8 w-9 place-items-center rounded-full transition-colors',
                  view === v
                    ? 'bg-card text-foreground ring-border shadow-sm ring-1'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3 px-5 pt-5 sm:px-6" aria-hidden="true">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-60 w-full" />
        </div>
      ) : error ? (
        <AnalyticsErrorState message={error.message} onRetry={() => void refetch()} />
      ) : !data?.length || total === 0 ? (
        <StateMessage
          icon={<BarChart3 aria-hidden="true" />}
          message={t('empty')}
          className="py-12"
        />
      ) : (
        <>
          <div className="flex items-baseline gap-2.5 px-5 pt-4 sm:px-6">
            <Figure
              value={total}
              kind="compact"
              className="text-[2.2rem] font-light leading-none tracking-[-0.045em]"
            />
            <span className="text-muted-foreground text-sm">{t('totalCaption')}</span>
          </div>
          {view === 'chart' ? (
            <Plot points={data} range={range} />
          ) : (
            <DataTable points={data} range={range} />
          )}
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 px-5 pt-3 text-xs sm:px-6">
            <span className="inline-flex items-center gap-2">
              <i className="bg-primary size-2.5 rounded-[2px]" aria-hidden="true" />
              {t('requests')}
            </span>
            <span className="inline-flex items-center gap-2">
              <i className="bg-destructive h-0.5 w-3.5 rounded-full" aria-hidden="true" />
              {t('errorRate')}
            </span>
            <span className="ms-auto font-mono text-[0.68rem]">{'UTC'}</span>
          </div>
        </>
      )}
    </Card>
  );
}
