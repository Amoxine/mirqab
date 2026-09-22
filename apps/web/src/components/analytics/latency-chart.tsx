'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslations } from 'next-intl';
import {
  AXIS_TICK,
  ChartCard,
  GRID_STROKE,
  TOOLTIP_STYLE,
  formatBucket,
  formatCount,
} from '@/components/analytics/analytics-empty-state';
import { useAnalyticsTimeSeries } from '@/hooks/use-analytics';
import type { AnalyticsRange } from '@/types';

/**
 * Single series on purpose: `GET /analytics/timeseries` carries only the end-to-end `avgLatencyMs` per bucket
 * (upstream latency exists only as a period average, shown in the overview tile).
 */
export function LatencyChart({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
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
            tickFormatter={(value: string) => formatBucket(value, range)}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(value: number) => `${formatCount(value)} ms`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(label: unknown) => (typeof label === 'string' ? formatBucket(label, range, true) : '')}
          />
          <Line
            type="monotone"
            dataKey="avgLatencyMs"
            name={t('charts.latency.series')}
            unit=" ms"
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
