'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';
import type { Locale } from '@/i18n/locales';
import type { AnalyticsHealth, AnalyticsRange } from '@/types';

/*
 * Shared building blocks for the analytics UI: the empty / error states, the chart card that
 * switches between loading / error / empty / chart, and the axis + number formatting the charts share.
 */

// ─── Formatting ─────────────────────────────────────────────────

/** `errorRate` is already a percentage (0-100). */
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

export const formatMs = (value: number): string => `${Math.round(value).toLocaleString()} ms`;

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact' });
export const formatCount = (value: number): string => compactNumber.format(value);

// The API truncates buckets to UTC instants, so labels are formatted in UTC too: local time would shift day buckets.
const utcFormat = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' });
const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
const dayFormat = utcFormat({ month: 'short', day: 'numeric' });
const dayYearFormat = utcFormat({ month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = utcFormat(time);
const dayTimeFormat = utcFormat({ month: 'short', day: 'numeric', ...time });

/**
 * Time-axis label (UTC) for a bucket start. Buckets are minutes (`1h`), hours (`24h`, `7d`) or days (`30d`);
 * `long` is the tooltip variant.
 */
export function formatBucket(bucket: string, range: AnalyticsRange, long = false): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  if (range === '30d') return (long ? dayYearFormat : dayFormat).format(date);
  if (range === '7d') return dayTimeFormat.format(date);
  return (long ? dayTimeFormat : timeFormat).format(date);
}

// ─── Shared recharts props ──────────────────────────────────────

export const CHART_HEIGHT_CLASS = 'h-[280px]';
export const AXIS_TICK = { fontSize: 12, fill: 'var(--color-muted-foreground)' } as const;
export const GRID_STROKE = 'var(--color-border)';
export const TOOLTIP_STYLE = {
  background: 'var(--color-card)',
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

// ponytail: mirrors pipeline-status.ts's `pipelineHint` conditions but returns a translation key —
// that file is owned by another workstream, so the English copy isn't sourced from it directly.
function pipelineHintKey(health: AnalyticsHealth): string {
  if (!health.pumpReachable) return 'emptyState.hintPumpDown';
  if (!health.rawTablePresent || !health.aggregateTablePresent) return 'emptyState.hintTablesMissing';
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
      <BarChart3 className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{notReady ? t('emptyState.pipelineNotReady') : t('emptyState.noDataTitle')}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {notReady ? t(pipelineHintKey(health)) : description ?? t('emptyState.defaultDescription')}
      </p>
      {notReady && (
        <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-start text-xs text-muted-foreground">
          <dt>{t('emptyState.pump')}</dt>
          <dd>{health.pumpReachable ? t('emptyState.pumpRunning') : t('emptyState.pumpNotRunning')}</dd>
          <dt>{t('emptyState.rawTable')}</dt>
          <dd>{health.rawTablePresent ? t('emptyState.present') : t('emptyState.missing')}</dd>
          <dt>{t('emptyState.aggregateTable')}</dt>
          <dd>{health.aggregateTablePresent ? t('emptyState.present') : t('emptyState.missing')}</dd>
          <dt>{t('emptyState.rowsRecorded')}</dt>
          <dd>{health.rowCount.toLocaleString()}</dd>
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
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" aria-hidden="true" />
      <div>
        <p className="font-medium">{t('staleNotice.title')}</p>
        <p className="text-muted-foreground">
          {t('staleNotice.description', { lastRecord: lastRecordLabel(t, health, locale) })}
        </p>
      </div>
    </div>
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
    <div
      role="alert"
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 py-6 text-center',
        className,
      )}
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <p className="text-sm font-medium">{t('errorState.title')}</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="me-2 h-4 w-4" />
        {tCommon('retry')}
      </Button>
    </div>
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

/** A card whose body is never an empty canvas: skeleton while loading, retryable error, empty state, or the chart. */
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
  let body: ReactNode = children;
  if (isLoading) body = <Skeleton className="h-full w-full" />;
  else if (error) body = <AnalyticsErrorState message={error.message} onRetry={onRetry} />;
  else if (isEmpty) body = <AnalyticsEmptyState description={emptyMessage} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={CHART_HEIGHT_CLASS}>{body}</div>
      </CardContent>
    </Card>
  );
}
