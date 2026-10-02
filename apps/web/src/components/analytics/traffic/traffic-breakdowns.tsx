'use client';

import { useId } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { FIGURE_LINK, RowLink, rowLinkProps } from '@/components/shared/row-link';
import { Card } from '@/components/ui/card';
import { Eyebrow, ShareList } from '@open-gateway/ui';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useFormat } from '@/hooks/use-format';
import { cn } from '@/lib/utils';
import type { AnalyticsTraffic, TrafficEndpoint, TrafficFilters } from '@/types';

/** The bar colour follows what the class means, so a glance separates healthy from failing traffic. */
const CLASS_TONE = {
  '2xx': '',
  '3xx': 'bg-info',
  '4xx': 'bg-warning',
  '5xx': 'bg-destructive',
} as const;

/**
 * How the filtered requests split by status class, method and the most frequent exact codes. Each
 * row filters the page to it in place (`onChange`, the page's own filters), and a second press on
 * the active one clears it; a class and an exact code replace each other, so the two never conflict.
 */
export function TrafficMix({
  data,
  filters,
  onChange,
}: {
  data: AnalyticsTraffic | undefined;
  filters: TrafficFilters;
  onChange: (patch: Partial<TrafficFilters>) => void;
}) {
  const t = useTranslations('analytics.traffic.mix');
  const tClasses = useTranslations('analytics.traffic.statusClasses');
  const fmt = useFormat();
  // Each breakdown is named by its own heading (not by a second copy of the same words in an aria-label).
  const ids = useId();

  const total = data?.summary.requests ?? 0;
  return (
    <Card variant="ink" className="p-4">
      <h2 className="text-base font-normal tracking-tight">{t('title')}</h2>
      {!data ? (
        <div className="mt-3 space-y-3" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : total === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">{t('empty')}</p>
      ) : (
        <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-1">
          <section aria-labelledby={`${ids}-class`}>
            <h3 id={`${ids}-class`} className="mb-2">
              <Eyebrow>{t('byClass')}</Eyebrow>
            </h3>
            <ShareList
              total={total}
              format={(value, share) => `${fmt.number(value)} · ${fmt.percent(share)}`}
              items={data.statusClasses.map((c) => ({
                key: c.class,
                label: tClasses(c.class),
                value: c.count,
                indicatorClassName: CLASS_TONE[c.class],
                selected: filters.statusClass === c.class,
                onSelect: () => {
                  onChange({
                    statusClass: filters.statusClass === c.class ? undefined : c.class,
                    status: undefined,
                  });
                },
              }))}
            />
          </section>
          <section aria-labelledby={`${ids}-method`}>
            <h3 id={`${ids}-method`} className="mb-2">
              <Eyebrow>{t('byMethod')}</Eyebrow>
            </h3>
            <ShareList
              total={total}
              format={(value, share) => `${fmt.number(value)} · ${fmt.percent(share)}`}
              items={data.methods.map((m) => ({
                key: m.method,
                label: m.method,
                value: m.count,
                selected: filters.method === m.method,
                onSelect: () => {
                  onChange({ method: filters.method === m.method ? undefined : m.method });
                },
              }))}
            />
          </section>
          <section aria-labelledby={`${ids}-code`} className="sm:col-span-2 xl:col-span-1">
            <h3 id={`${ids}-code`} className="mb-2">
              <Eyebrow>{t('byCode')}</Eyebrow>
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {data.statusCodes.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    aria-pressed={filters.status === c.code}
                    onClick={() => {
                      onChange({
                        status: filters.status === c.code ? undefined : c.code,
                        statusClass: undefined,
                      });
                    }}
                    className="hover:bg-accent focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:border-foreground flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs focus-visible:outline-hidden focus-visible:ring-2"
                  >
                    {/* The pressed state is a check mark as well as a fill and a border colour. */}
                    {filters.status === c.code && <Check className="size-3" aria-hidden="true" />}
                    <span
                      className={cn(
                        c.code >= 500 && 'text-destructive',
                        c.code >= 400 && c.code < 500 && 'text-warning',
                      )}
                    >
                      {c.code}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {fmt.number(c.count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Card>
  );
}

/**
 * A ranked endpoint table; `emphasis` picks which latency column is the one the ranking is about.
 * `rowHref` is where an endpoint leads (the requests behind it): a click on the row follows a hidden
 * link to it, and the path is the keyboard's link to the same place, named with its method (the badge
 * beside it is not part of the link); without it (or when it gives nothing) the rows are plain.
 */
export function EndpointTable({
  title,
  description,
  rows,
  loading,
  emphasis,
  emptyMessage,
  rowHref,
}: {
  title: string;
  description: string;
  rows: TrafficEndpoint[] | undefined;
  loading: boolean;
  emphasis: 'requests' | 'p95';
  emptyMessage: string;
  rowHref?: (row: TrafficEndpoint) => string | undefined;
}) {
  const t = useTranslations('analytics.traffic.endpoints');
  const fmt = useFormat();

  return (
    <Card variant="ink" className="overflow-hidden">
      <div className="p-4 pb-1">
        <h2 className="text-base font-normal tracking-tight">{title}</h2>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="px-2 pb-2">
        <Table className="min-w-[520px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t('endpoint')}</TableHead>
              <TableHead className="text-end">{t('requests')}</TableHead>
              <TableHead className="text-end">{t('errorRate')}</TableHead>
              <TableHead className="text-end">{t('avg')}</TableHead>
              <TableHead className="text-end">{t('p95')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : !rows?.length ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-6 text-center text-sm">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const href = rowHref?.(row);
                return (
                  <TableRow
                    key={`${row.method} ${row.path}`}
                    {...(href ? rowLinkProps('[&>th:first-child]:rounded-s-xl') : undefined)}
                  >
                    <th scope="row" className="max-w-64 px-3 py-2 text-start align-middle font-normal">
                      {href && <RowLink href={href} />}
                      <div className="flex items-center gap-2">
                        {/* The link's own text starts with the method, so the badge would read it twice. */}
                        <span aria-hidden={href ? 'true' : undefined}>
                          <MethodBadge method={row.method} />
                        </span>
                        {href ? (
                          <Link
                            href={href}
                            dir="ltr"
                            title={row.path}
                            className={cn(FIGURE_LINK, 'truncate font-mono text-xs')}
                          >
                            <span className="sr-only">{row.method}</span>{' '}
                            {row.path}
                          </Link>
                        ) : (
                          <span dir="ltr" title={row.path} className="truncate font-mono text-xs">
                            {row.path}
                          </span>
                        )}
                      </div>
                    </th>
                    <TableCell
                      className={cn(
                        'text-end tabular-nums',
                        emphasis === 'requests' && 'font-medium',
                      )}
                    >
                      {fmt.number(row.requests)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-end tabular-nums',
                        row.errorRate >= 5 && 'text-destructive',
                      )}
                    >
                      {fmt.percent(row.errorRate)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {fmt.ms(row.avgLatencyMs)}
                    </TableCell>
                    <TableCell
                      className={cn('text-end tabular-nums', emphasis === 'p95' && 'font-medium')}
                    >
                      {fmt.ms(row.p95LatencyMs)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
