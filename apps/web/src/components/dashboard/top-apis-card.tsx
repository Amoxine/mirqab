'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState, formatCount } from '@/components/analytics/analytics-empty-state';
import { StretchedLink } from '@/components/shared/row-link';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsApis, useAnalyticsOverview, useAnalyticsTraffic } from '@/hooks/use-analytics';
import { usePermissions } from '@/hooks/use-permissions';
import { trafficHref } from '@/lib/traffic-filters-to-query';
import { cn } from '@/lib/utils';
import type { AnalyticsRange } from '@/types';
import { ScopeTag } from './scope-tag';

/**
 * Share of requests for the three busiest APIs plus everything else, as columns. Narrowed to one
 * API (`scope`) the columns are that API's busiest endpoints instead.
 */
export function TopApisCard({
  range,
  scope,
}: {
  range: AnalyticsRange;
  scope?: { id: string; name: string } | null;
}) {
  const t = useTranslations('dashboard.topApis');
  const locale = useLocale();
  const { can } = usePermissions();
  const apis = useAnalyticsApis(range, !scope);
  const traffic = useAnalyticsTraffic({ range, apiId: scope?.id }, !!scope);
  const overview = useAnalyticsOverview(range, scope?.id);
  const rows = scope ? traffic : apis;
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });

  const total = overview.data?.totalRequests ?? 0;
  // Each slice opens the traffic behind it: an API's, or (narrowed to one API) one endpoint's. An API
  // slice also keeps a second link to the API itself, from its name, for someone who may open it.
  const ranked = scope
    ? (traffic.data?.topEndpoints ?? []).map((row) => ({
        apiDefId: `${row.method} ${row.path}`,
        name: `${row.method} ${row.path}`,
        slug: row.path,
        requests: row.requests,
        href: trafficHref({ range, apiId: scope.id, method: row.method, path: row.path }),
        detailHref: null,
      }))
    : (apis.data ?? []).map((row) => ({
        ...row,
        href: trafficHref({ range, apiId: row.apiDefId }),
        detailHref: can('api:read') ? `/apis/${row.apiDefId}` : null,
      }));
  const top = ranked.filter((row) => row.requests > 0).slice(0, 3);
  const topSum = top.reduce((sum, row) => sum + row.requests, 0);
  // The rest of the range's traffic, from the overview total (the per-API list is capped).
  const others = Math.max(0, total - topSum);
  const columns = [
    ...top.map((row) => ({
      key: row.apiDefId,
      label: row.name,
      sub: row.slug,
      value: row.requests,
      href: row.href,
      detailHref: row.detailHref,
    })),
    ...(others > 0
      ? [{ key: 'others', label: t('others'), sub: null, value: others, href: null, detailHref: null }]
      : []),
  ];
  const max = Math.max(...columns.map((c) => c.value), 1);

  return (
    <Card variant="ink" className="flex flex-col p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-lg font-normal tracking-tight">
          {scope ? t('titleEndpoints') : t('title')}
          <ScopeTag name={scope?.name} />
        </h2>
        <Link
          href={scope ? trafficHref({ range, apiId: scope.id }) : '/analytics'}
          aria-label={t('open')}
          className="bg-foreground text-card grid size-8 shrink-0 place-items-center rounded-full transition-transform duration-300 hover:rotate-45 rtl:-scale-x-100"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      {rows.isLoading || overview.isLoading ? (
        <div className="mt-4 grid flex-1 grid-cols-3 items-end gap-2" aria-hidden="true">
          {[80, 60, 45].map((h) => (
            <Skeleton
              key={h}
              className="w-full"
              style={{ height: `${String(h)}%`, minHeight: h * 1.6 }}
            />
          ))}
        </div>
      ) : rows.error || overview.error ? (
        <AnalyticsErrorState
          message={(rows.error ?? overview.error)?.message ?? t('empty')}
          onRetry={() => void rows.refetch()}
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
              return (
                <li key={c.key} className="flex min-w-0 flex-col justify-end">
                  <div className="mb-2 text-[clamp(1.35rem,2vw,1.9rem)] font-light leading-none tracking-[-0.045em]">
                    {pct.format(share)}
                  </div>
                  {/* The count is the bar's link (its stretched ::after covers the bar); the name, when
                      it has a page of its own, is a second link lifted above it. */}
                  <div
                    className={cn(barClass, c.href && 'relative hover:brightness-125')}
                    style={barStyle}
                    title={c.href ? c.sub : c.label}
                  >
                    <span dir="auto" className="truncate text-start text-[0.72rem]">
                      {c.detailHref ? (
                        <Link
                          href={c.detailHref}
                          className="relative z-10 rounded-sm hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {c.label}
                        </Link>
                      ) : (
                        c.label
                      )}
                    </span>
                    <span className="text-muted-foreground truncate font-mono text-[0.64rem]">
                      {c.href ? (
                        <StretchedLink href={c.href} className="after:rounded-t-[4px]">
                          <span className="sr-only">{t('viewTraffic', { name: c.label })}</span>{' '}
                          {formatCount(c.value, locale)}
                        </StretchedLink>
                      ) : (
                        formatCount(c.value, locale)
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
