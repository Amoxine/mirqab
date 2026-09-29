'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsApis, useAnalyticsOverview } from '@/hooks/use-analytics';
import type { AnalyticsRange } from '@/types';

/** Share of requests for the three busiest APIs plus everything else, as columns. */
export function TopApisCard({ range }: { range: AnalyticsRange }) {
  const t = useTranslations('dashboard.topApis');
  const locale = useLocale();
  const apis = useAnalyticsApis(range);
  const overview = useAnalyticsOverview(range);
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });

  const total = overview.data?.totalRequests ?? 0;
  const top = (apis.data ?? []).filter((row) => row.requests > 0).slice(0, 3);
  const topSum = top.reduce((sum, row) => sum + row.requests, 0);
  // The rest of the range's traffic, from the overview total (the per-API list is capped).
  const others = Math.max(0, total - topSum);
  const columns = [
    ...top.map((row) => ({
      key: row.apiDefId,
      label: row.name,
      sub: row.slug,
      value: row.requests,
      href: `/apis/${row.apiDefId}`,
    })),
    ...(others > 0
      ? [{ key: 'others', label: t('others'), sub: null, value: others, href: null }]
      : []),
  ];
  const max = Math.max(...columns.map((c) => c.value), 1);

  return (
    <Card variant="ink" className="flex flex-col p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-normal tracking-tight">{t('title')}</h2>
        <Link
          href="/analytics"
          aria-label={t('open')}
          className="bg-foreground text-card grid size-8 shrink-0 place-items-center rounded-full transition-transform duration-300 hover:rotate-45 rtl:-scale-x-100"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      {apis.isLoading || overview.isLoading ? (
        <div className="mt-4 grid flex-1 grid-cols-3 items-end gap-2" aria-hidden="true">
          {[80, 60, 45].map((h) => (
            <Skeleton
              key={h}
              className="w-full"
              style={{ height: `${String(h)}%`, minHeight: h * 1.6 }}
            />
          ))}
        </div>
      ) : apis.error || overview.error ? (
        <AnalyticsErrorState
          message={(apis.error ?? overview.error)?.message ?? t('empty')}
          onRetry={() => void apis.refetch()}
        />
      ) : total === 0 || columns.length === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm">{t('empty')}</p>
      ) : (
        <>
          <p className="text-muted-foreground mt-1 text-sm">
            {t.rich('total', {
              count: formatCount(total, locale),
              b: (chunks) => <b className="text-foreground me-1 font-medium">{chunks}</b>,
            })}
          </p>
          <ul
            className="mt-3 grid min-h-36 flex-1 gap-2"
            style={{ gridTemplateColumns: `repeat(${String(columns.length)}, minmax(0, 1fr))` }}
          >
            {columns.map((c) => {
              const share = c.value / total;
              // The bar's height is a share of the column's full height, so its value label sits right on its cap.
              const barClass =
                'flex flex-col justify-end rounded-t-[4px] border-t-2 border-primary bg-gradient-to-b from-foreground/20 to-foreground/[0.04] px-2 pb-2 transition-[height] duration-500';
              const barStyle = { height: `${Math.max(18, (c.value / max) * 72).toFixed(1)}%` };
              const inner = (
                <>
                  <span dir="auto" className="truncate text-start text-[0.72rem]">
                    {c.label}
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-[0.64rem]">
                    {formatCount(c.value, locale)}
                  </span>
                </>
              );
              return (
                <li key={c.key} className="flex min-w-0 flex-col justify-end">
                  <div className="mb-2 text-[clamp(1.35rem,2vw,1.9rem)] font-light leading-none tracking-[-0.045em]">
                    {pct.format(share)}
                  </div>
                  {c.href ? (
                    <Link
                      href={c.href}
                      className={`${barClass} hover:brightness-125`}
                      style={barStyle}
                      title={c.sub}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className={barClass} style={barStyle}>
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
