'use client';

import { Notice } from '@open-gateway/ui';
import type { ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { ChartCard as BaseChartCard, ErrorState } from '@open-gateway/ui';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';
import type { Locale } from '@/i18n/locales';
import type { AnalyticsHealth, AnalyticsRange } from '@/types';
import { FormattedNumber } from '@/components/shared/formatted';

/*
 * Shared building blocks for the analytics UI: the empty / error states, the chart card that
 * switches between loading / error / empty / chart, and the axis + number formatting the charts share.
 */

// ─── Formatting ─────────────────────────────────────────────────

// Percent and millisecond formatting live in `hooks/use-format.ts` (locale-aware units).

/** Intl formatters are costly to build and charts format every tick, so one per locale+options. */
const formatterCache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = make();
    formatterCache.set(key, formatter);
  }
  return formatter as T;
}

/** `locale` is the UI locale (`useLocale()`), so axis labels read in the user's language. */
export const formatCount = (value: number, locale = 'en'): string =>
  cached(`n:${locale}`, () => new Intl.NumberFormat(locale, { notation: 'compact' })).format(value);

// The API truncates buckets to UTC instants, so labels are formatted in UTC too: local time would shift day buckets.
const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
const BUCKET_FORMATS = {
  day: { month: 'short', day: 'numeric' },
  dayYear: { month: 'short', day: 'numeric', year: 'numeric' },
  time,
  dayTime: { month: 'short', day: 'numeric', ...time },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;
const utcFormat = (kind: keyof typeof BUCKET_FORMATS, locale: string) =>
  cached(
    `d:${kind}:${locale}`,
    () => new Intl.DateTimeFormat(locale, { ...BUCKET_FORMATS[kind], timeZone: 'UTC' }),
  );

/**
 * Time-axis label (UTC) for a bucket start. Buckets are minutes (`1h`), hours (`24h`, `7d`) or days (`30d`);
 * `long` is the tooltip variant.
 */
export function formatBucket(
  bucket: string,
  range: AnalyticsRange,
  long = false,
  locale = 'en',
): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  if (range === '30d') return utcFormat(long ? 'dayYear' : 'day', locale).format(date);
  if (range === '7d') return utcFormat('dayTime', locale).format(date);
  return utcFormat(long ? 'dayTime' : 'time', locale).format(date);
}

// ─── Shared recharts props ──────────────────────────────────────

export const CHART_HEIGHT_CLASS = 'h-[280px]';
export const AXIS_TICK = { fontSize: 12, fill: 'var(--color-muted-foreground)' } as const;
export const GRID_STROKE = 'var(--color-border)';
export const TOOLTIP_STYLE = {
  background: 'var(--color-popover)',
  // recharts' tooltip label otherwise keeps its built-in dark text, unreadable on the dark card.
  color: 'var(--color-popover-foreground)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  fontSize: 12,
} as const;

// ─── States ─────────────────────────────────────────────────────

const lastRecordLabel = (
  t: ReturnType<typeof useTranslations>,
  health: AnalyticsHealth,
  locale: ReturnType<typeof dateFnsLocale>,
): string =>
  health.lastRecordAt
    ? formatDistanceToNow(new Date(health.lastRecordAt), { addSuffix: true, locale })
    : t('emptyState.never');

// Which hint to show, as a translation key: the collector being down outranks missing tables, which
// outrank "no requests yet" (covered by analytics-empty-state.test.tsx).
function pipelineHintKey(health: AnalyticsHealth): string {
  if (!health.pumpReachable) return 'emptyState.hintPumpDown';
  if (!health.rawTablePresent || !health.aggregateTablePresent)
    return 'emptyState.hintTablesMissing';
  return 'emptyState.hintNoTraffic';
}

interface AnalyticsEmptyStateProps {
  /** When the pipeline reports it is not ready, the state explains why instead of showing `description`. */
  health?: AnalyticsHealth;
  description?: string;
  className?: string;
}

export function AnalyticsEmptyState({ health, description, className }: AnalyticsEmptyStateProps) {
  const t = useTranslations('analytics');
  const locale = dateFnsLocale(useLocale() as Locale);
  const notReady = health !== undefined && !health.pipelineReady;

  return (
    <div
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 py-6 text-center',
        className,
      )}
    >
      <BarChart3 className="text-muted-foreground h-8 w-8" aria-hidden="true" />
      <p className="text-sm font-medium">
        {notReady ? t('emptyState.pipelineNotReady') : t('emptyState.noDataTitle')}
      </p>
      <p className="text-muted-foreground max-w-md text-sm">
        {notReady
          ? t(pipelineHintKey(health))
          : (description ?? t('emptyState.defaultDescription'))}
      </p>
      {notReady && (
        <dl className="text-muted-foreground mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-start text-xs">
          <dt>{t('emptyState.pump')}</dt>
          <dd>
            {health.pumpReachable ? t('emptyState.pumpRunning') : t('emptyState.pumpNotRunning')}
          </dd>
          <dt>{t('emptyState.rawTable')}</dt>
          <dd>{health.rawTablePresent ? t('emptyState.present') : t('emptyState.missing')}</dd>
          <dt>{t('emptyState.aggregateTable')}</dt>
          <dd>
            {health.aggregateTablePresent ? t('emptyState.present') : t('emptyState.missing')}
          </dd>
          <dt>{t('emptyState.rowsRecorded')}</dt>
          <dd>
            <FormattedNumber value={health.rowCount} />
          </dd>
          <dt>{t('emptyState.lastRecord')}</dt>
          <dd>{lastRecordLabel(t, health, locale)}</dd>
        </dl>
      )}
    </div>
  );
}

/** Degraded-pipeline banner: the pump is down while older data is still shown below it. */
export function AnalyticsStaleNotice({ health }: { health: AnalyticsHealth }) {
  const t = useTranslations('analytics');
  const locale = dateFnsLocale(useLocale() as Locale);
  return (
    <Notice role="status" title={t('staleNotice.title')}>
      {t('staleNotice.description', { lastRecord: lastRecordLabel(t, health, locale) })}
    </Notice>
  );
}

interface AnalyticsErrorStateProps {
  message: string;
  onRetry: () => void;
  className?: string;
}

export function AnalyticsErrorState({ message, onRetry, className }: AnalyticsErrorStateProps) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  return (
    <ErrorState
      title={t('errorState.title')}
      message={message}
      retryLabel={tCommon('retry')}
      onRetry={onRetry}
      className={className}
    />
  );
}

// ─── Chart card ─────────────────────────────────────────────────

interface ChartCardProps {
  title: string;
  description: string;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  isEmpty: boolean;
  emptyMessage?: string;
  /** The chart itself; rendered inside a fixed-height box, so use `<ResponsiveContainer height="100%">`. */
  children: ReactNode;
}

/** A chart card whose loading / error / empty states are the analytics ones (translated, with retry). */
export function ChartCard({
  title,
  description,
  isLoading,
  error,
  onRetry,
  isEmpty,
  emptyMessage,
  children,
}: ChartCardProps) {
  const status = isLoading ? 'loading' : error ? 'error' : isEmpty ? 'empty' : 'ready';
  return (
    <BaseChartCard
      title={title}
      description={description}
      status={status}
      heightClass={CHART_HEIGHT_CLASS}
      errorContent={
        error ? <AnalyticsErrorState message={error.message} onRetry={onRetry} /> : null
      }
      emptyContent={<AnalyticsEmptyState description={emptyMessage} />}
    >
      {children}
    </BaseChartCard>
  );
}
