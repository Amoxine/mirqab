'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLocale, useTranslations } from 'next-intl';
import {
  AXIS_TICK,
  ChartCard,
  GRID_STROKE,
  TOOLTIP_STYLE,
  formatBucket,
} from '@/components/analytics/analytics-empty-state';
import { usePrefersReducedMotion } from '@/hooks/use-media-query';
import { useAnalyticsTimeSeries } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';
import type { AnalyticsRange } from '@/types';

/**
 * Single series on purpose: `GET /analytics/timeseries` carries only the end-to-end `avgLatencyMs` per bucket
 * (upstream latency exists only as a period average, shown in the overview tile).
 */
export function LatencyChart({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const fmt = useFormat();
  const animate = !usePrefersReducedMotion();
  const { data, isLoading, error, refetch } = useAnalyticsTimeSeries('latency', range);

  return (
    <ChartCard
      title={t('charts.latency.title')}
      description={t('charts.latency.description')}
      isLoading={isLoading}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={!data?.some((point) => point.avgLatencyMs > 0)}
      emptyMessage={t('charts.latency.empty')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(value: string) => formatBucket(value, range, false, locale)}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(value: number) => fmt.ms(value)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(label: unknown) => (typeof label === 'string' ? formatBucket(label, range, true, locale) : '')}
            // The unit is Intl's for the locale, not a string written here.
            formatter={(value) => (typeof value === 'number' ? fmt.ms(value) : String(value))}
          />
          <Line
            isAnimationActive={animate}
            type="monotone"
            dataKey="avgLatencyMs"
            name={t('charts.latency.series')}
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
