'use client';

import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AXIS_TICK,
  GRID_STROKE,
  TOOLTIP_STYLE,
  formatBucket,
  formatCount,
} from '@/components/analytics/analytics-empty-state';
import { StateMessage } from '@/components/shared/state-card';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/hooks/use-format';
import { usePrefersReducedMotion } from '@/hooks/use-media-query';
import type { AnalyticsTraffic } from '@/types';

const MARGIN = { top: 14, right: 8, bottom: 0, left: 0 };

/** Dark chart card: title, one line of description, and a fixed-height body that is never an empty canvas. */
function ChartFrame({
  title,
  description,
  loading,
  empty,
  emptyMessage,
  children,
}: {
  title: string;
  description: string;
  loading: boolean;
  empty: boolean;
  emptyMessage: string;
  children: ReactNode;
}) {
  return (
    <Card variant="ink" className="flex flex-col p-4">
      <h2 className="text-base font-normal tracking-tight">{title}</h2>
      <p className="text-muted-foreground mb-2 text-xs">{description}</p>
      {/* The body takes whatever height the row gives the card (never less than 220px), so a taller
          neighbour stretches the chart instead of leaving blank space under it. */}
      <div className="relative min-h-[220px] flex-1">
        <div className="absolute inset-0">
          {loading ? (
            <Skeleton className="h-full w-full" />
          ) : empty ? (
            <StateMessage
              icon={<BarChart3 aria-hidden="true" />}
              message={emptyMessage}
              className="h-full"
            />
          ) : (
            // The chart is an image to assistive tech; the KPI tiles and tables carry the same numbers as text.
            <div role="img" aria-label={`${title}. ${description}`} className="h-full">
              {children}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Requests and errors per bucket for the filtered traffic. */
export function TrafficVolumeChart({ data }: { data: AnalyticsTraffic | undefined }) {
  const t = useTranslations('analytics.traffic.charts');
  const locale = useLocale();
  const animate = !usePrefersReducedMotion();
  const points = data?.timeseries ?? [];
  const range = data?.range ?? '24h';

  return (
    <ChartFrame
      title={t('volume')}
      description={t('volumeDescription')}
      loading={!data}
      empty={!points.some((p) => p.requests > 0)}
      emptyMessage={t('empty')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(v: string) => formatBucket(v, range, false, locale)}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={44}
            tickFormatter={(v: number) => formatCount(v, locale)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(l: unknown) =>
              typeof l === 'string' ? formatBucket(l, range, true, locale) : ''
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area
            isAnimationActive={animate}
            type="monotone"
            dataKey="requests"
            name={t('requests')}
            stroke="var(--color-primary)"
            fill="var(--color-primary)"
            fillOpacity={0.18}
            strokeWidth={2}
          />
          <Area
            isAnimationActive={animate}
            type="monotone"
            dataKey="errors"
            name={t('errors')}
            stroke="var(--color-destructive)"
            fill="var(--color-destructive)"
            fillOpacity={0.12}
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Average and 95th-percentile latency per bucket: the gap between them is the tail users feel. */
export function TrafficLatencyChart({ data }: { data: AnalyticsTraffic | undefined }) {
  const t = useTranslations('analytics.traffic.charts');
  const fmt = useFormat();
  const locale = useLocale();
  const animate = !usePrefersReducedMotion();
  const points = data?.timeseries ?? [];
  const range = data?.range ?? '24h';

  return (
    <ChartFrame
      title={t('latency')}
      description={t('latencyDescription')}
      loading={!data}
      empty={!points.some((p) => p.requests > 0)}
      emptyMessage={t('empty')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(v: string) => formatBucket(v, range, false, locale)}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => fmt.ms(v)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(l: unknown) =>
              typeof l === 'string' ? formatBucket(l, range, true, locale) : ''
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            isAnimationActive={animate}
            type="monotone"
            dataKey="avgLatencyMs"
            name={t('avg')}
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            isAnimationActive={animate}
            type="monotone"
            dataKey="p95LatencyMs"
            name={t('p95')}
            stroke="var(--color-warning)"
            strokeWidth={2}
            dot={false}
            strokeDasharray="5 3"
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
