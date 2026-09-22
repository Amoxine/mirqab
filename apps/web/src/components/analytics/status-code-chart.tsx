'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslations } from 'next-intl';
import {
  AXIS_TICK,
  ChartCard,
  GRID_STROKE,
  TOOLTIP_STYLE,
  formatCount,
} from '@/components/analytics/analytics-empty-state';
import { useAnalyticsStatusCodes } from '@/hooks/use-analytics';
import { toStatusRows } from './status-code-utils';
import type { AnalyticsRange } from '@/types';

export function StatusCodeChart({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const { data, isLoading, error, refetch } = useAnalyticsStatusCodes(range);

  // One key per class: stacking then colours each bar by class and gives the legend real meaning
  // without per-cell colour overrides.
  const rows = toStatusRows(data ?? []);

  return (
    <ChartCard
      title={t('charts.statusCodes.title')}
      description={t('charts.statusCodes.description')}
      isLoading={isLoading}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={!data?.some((item) => item.count > 0)}
      emptyMessage={t('charts.statusCodes.empty')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis dataKey="code" tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={44}
            tickFormatter={formatCount}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--color-muted)' }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="ok" name={t('charts.statusCodes.success')} stackId="status" fill="var(--color-success)" maxBarSize={48} radius={[4, 4, 0, 0]} />
          <Bar dataKey="client" name={t('charts.statusCodes.clientError')} stackId="status" fill="var(--color-warning)" maxBarSize={48} radius={[4, 4, 0, 0]} />
          <Bar dataKey="server" name={t('charts.statusCodes.serverError')} stackId="status" fill="var(--color-destructive)" maxBarSize={48} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
