'use client';

import { useTranslations } from 'next-intl';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
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
import type { AnalyticsTraffic, TrafficEndpoint } from '@/types';

/** The bar colour follows what the class means, so a glance separates healthy from failing traffic. */
const CLASS_TONE = {
  '2xx': '',
  '3xx': 'bg-info',
  '4xx': 'bg-warning',
  '5xx': 'bg-destructive',
} as const;

/** How the filtered requests split by status class, method and the most frequent exact codes. */
export function TrafficMix({ data }: { data: AnalyticsTraffic | undefined }) {
  const t = useTranslations('analytics.traffic.mix');
  const tClasses = useTranslations('analytics.traffic.statusClasses');
  const fmt = useFormat();

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
          <section aria-label={t('byClass')}>
            <h3 className="mb-2">
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
              }))}
            />
          </section>
          <section aria-label={t('byMethod')}>
            <h3 className="mb-2">
              <Eyebrow>{t('byMethod')}</Eyebrow>
            </h3>
            <ShareList
              total={total}
              format={(value, share) => `${fmt.number(value)} · ${fmt.percent(share)}`}
              items={data.methods.map((m) => ({ key: m.method, label: m.method, value: m.count }))}
            />
          </section>
          <section aria-label={t('byCode')} className="sm:col-span-2 xl:col-span-1">
            <h3 className="mb-2">
              <Eyebrow>{t('byCode')}</Eyebrow>
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {data.statusCodes.map((c) => (
                <li
                  key={c.code}
                  className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs"
                >
                  <span
                    className={cn(
                      c.code >= 500 && 'text-destructive',
                      c.code >= 400 && c.code < 500 && 'text-warning',
                    )}
                  >
                    {c.code}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{fmt.number(c.count)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Card>
  );
}

/** A ranked endpoint table; `emphasis` picks which latency column is the one the ranking is about. */
export function EndpointTable({
  title,
  description,
  rows,
  loading,
  emphasis,
  emptyMessage,
}: {
  title: string;
  description: string;
  rows: TrafficEndpoint[] | undefined;
  loading: boolean;
  emphasis: 'requests' | 'p95';
  emptyMessage: string;
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
              rows.map((row) => (
                <TableRow key={`${row.method} ${row.path}`}>
                  <TableCell className="max-w-64">
                    <div className="flex items-center gap-2">
                      <MethodBadge method={row.method} />
                      <span dir="ltr" title={row.path} className="truncate font-mono text-xs">
                        {row.path}
                      </span>
                    </div>
                  </TableCell>
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
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
