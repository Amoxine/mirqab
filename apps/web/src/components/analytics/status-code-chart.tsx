'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLocale, useTranslations } from 'next-intl';
import {
  AXIS_TICK,
  ChartCard,
  GRID_STROKE,
  TOOLTIP_STYLE,
  formatCount,
} from '@/components/analytics/analytics-empty-state';
import { usePrefersReducedMotion } from '@/hooks/use-media-query';
import { useAnalyticsStatusCodes } from '@/hooks/use-analytics';
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { searchHref, statusCodeTokens } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import { toStatusRows } from './status-code-utils';
import type { AnalyticsRange } from '@/types';

export function StatusCodeChart({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const router = useRouter();
  const canSearch = useCanSearchRequests();
  const animate = !usePrefersReducedMotion();
  const { data, isLoading, error, refetch } = useAnalyticsStatusCodes(range);

  // One key per class: stacking then colours each bar by class and gives the legend real meaning
  // without per-cell colour overrides.
  const rows = toStatusRows(data ?? []);
  const hrefFor = (code: string) => searchHref(statusCodeTokens(code), range);
  // A bar opens the requests with its status (for a pointer; the chart is an image to assistive
  // technology, so the same links are listed under it as real links for everyone else, and, for
  // someone who cannot search, the same figures as plain text). So the chart itself has no
  // accessibility layer: it would be a keyboard stop that does nothing.
  const openBar = canSearch
    ? (_bar: unknown, index: number) => {
        const code = rows[index]?.code;
        if (code !== undefined) router.push(hrefFor(code));
      }
    : undefined;

  return (
    <div className="space-y-3">
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
          <BarChart data={rows} accessibilityLayer={false} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
            <XAxis dataKey="code" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              width={44}
              tickFormatter={(value: number) => formatCount(value, locale)}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--color-muted)' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              isAnimationActive={animate}
              dataKey="ok"
              name={t('charts.statusCodes.success')}
              stackId="status"
              fill="var(--color-success)"
              maxBarSize={48}
              radius={[4, 4, 0, 0]}
              cursor={canSearch ? 'pointer' : undefined}
              onClick={openBar}
            />
            <Bar
              isAnimationActive={animate}
              dataKey="client"
              name={t('charts.statusCodes.clientError')}
              stackId="status"
              fill="var(--color-warning)"
              maxBarSize={48}
              radius={[4, 4, 0, 0]}
              cursor={canSearch ? 'pointer' : undefined}
              onClick={openBar}
            />
            <Bar
              isAnimationActive={animate}
              dataKey="server"
              name={t('charts.statusCodes.serverError')}
              stackId="status"
              fill="var(--color-destructive)"
              maxBarSize={48}
              radius={[4, 4, 0, 0]}
              cursor={canSearch ? 'pointer' : undefined}
              onClick={openBar}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      {canSearch && rows.length > 0 && (
        <nav aria-label={t('charts.statusCodes.browse')}>
          <ul className="flex flex-wrap gap-1.5">
            {rows.map((row) => (
              <li key={row.code}>
                <Link
                  href={hrefFor(row.code)}
                  className="hover:bg-accent focus-visible:ring-ring flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs focus-visible:outline-hidden focus-visible:ring-2"
                >
                  <span
                    className={cn(
                      row.server > 0 && 'text-destructive',
                      row.client > 0 && 'text-warning',
                    )}
                  >
                    {row.code}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatCount(row.ok + row.client + row.server, locale)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {!canSearch && rows.length > 0 && (
        <ul aria-label={t('charts.statusCodes.breakdown')} className="sr-only">
          {rows.map((row) => (
            <li key={row.code}>
              {t('charts.statusCodes.breakdownItem', {
                code: row.code,
                count: row.ok + row.client + row.server,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
