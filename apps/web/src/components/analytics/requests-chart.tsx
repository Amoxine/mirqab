'use client';

import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLocale, useTranslations } from 'next-intl';
import {
  AXIS_TICK,
  ChartCard,
  GRID_STROKE,
  TOOLTIP_STYLE,
  formatBucket,
  formatCount,
} from '@/components/analytics/analytics-empty-state';
import { usePrefersReducedMotion } from '@/hooks/use-media-query';
import { useAnalyticsTimeSeries } from '@/hooks/use-analytics';
import type { AnalyticsRange } from '@/types';

export function RequestsChart({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const animate = !usePrefersReducedMotion();
  const { data, isLoading, error, refetch } = useAnalyticsTimeSeries('requests', range);

  return (
    <ChartCard
      title={t('charts.requests.title')}
      description={t('charts.requests.description')}
      isLoading={isLoading}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={!data?.some((point) => point.requests > 0)}
      emptyMessage={t('charts.requests.empty')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            allowDecimals={false}
            width={44}
            tickFormatter={(value: number) => formatCount(value, locale)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(label: unknown) => (typeof label === 'string' ? formatBucket(label, range, true, locale) : '')}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area
            isAnimationActive={animate}
            type="monotone"
            dataKey="requests"
            name={t('charts.requests.requestsSeries')}
            stroke="var(--color-primary)"
            fill="var(--color-primary)"
            fillOpacity={0.15}
            strokeWidth={2}
            dot={false}
          />
          <Area
            isAnimationActive={animate}
            type="monotone"
            dataKey="errors"
            name={t('charts.requests.errorsSeries')}
            stroke="var(--color-destructive)"
            fill="var(--color-destructive)"
            fillOpacity={0.15}
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
