'use client';

import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { FormattedDateTime } from '@/components/shared/formatted';
import { StateMessage } from '@/components/shared/state-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormat } from '@/hooks/use-format';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { ApiRequestError } from '@/lib/api-client';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { statusVariant } from '@/lib/http-status';
import type { Locale } from '@/i18n/locales';

/** What the server said was wrong, in words a person can act on; the API's own text is English only. */
function ErrorView({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useTranslations('analytics.search.apiErrors');
  let message = t('generic');
  if (error instanceof ApiRequestError) {
    if (error.code === 'SEARCH_TOO_BROAD') message = t('tooBroad');
    else if (error.code === 'SEARCH_INVALID' || error.status === 400) message = t('invalid');
    else if (error.code === 'SEARCH_BUSY' || error.status === 429) message = t('busy');
    else if (error.status === 403) message = t('forbidden');
  }
  return <AnalyticsErrorState message={message} onRetry={onRetry} />;
}

/**
 * The matches, newest first, with "Load more" for the next page. Empty, loading, error and
 * "not indexed yet" are different states with different next steps, so each has its own message.
 */
export function SearchResults({
  items,
  isLoading,
  isRefetching,
  error,
  hasMore,
  isFetchingMore,
  hasFilters,
  indexedUntil,
  onLoadMore,
  onRetry,
  onOpen,
}: {
  items: TrafficSearchItem[];
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | null;
  hasMore: boolean;
  isFetchingMore: boolean;
  hasFilters: boolean;
  indexedUntil: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (item: TrafficSearchItem) => void;
}) {
  const t = useTranslations('analytics.search');
  const fmt = useFormat();
  const locale = dateFnsLocale(useLocale() as Locale);

  const freshness =
    indexedUntil === null
      ? t('notIndexedYet')
      : t('indexedUntil', { when: formatDistanceToNow(new Date(indexedUntil), { addSuffix: true, locale }) });

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('loading')}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorView error={error} onRetry={onRetry} />;

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs" role="status">
        {`${freshness} · ${t('coverage')}`}
      </p>
      {items.length === 0 ? (
        <StateMessage
          icon={<SearchX aria-hidden="true" />}
          message={indexedUntil === null ? t('notIndexedYet') : hasFilters ? t('emptyNoMatch') : t('emptyNoCapture')}
          className="py-10"
        />
      ) : (
        <div className={isRefetching ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={isRefetching}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.time')}</TableHead>
                <TableHead>{t('columns.api')}</TableHead>
                <TableHead>{t('columns.request')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="text-end">{t('columns.latency')}</TableHead>
                <TableHead>{t('columns.key')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={`${item.ts}-${item.id}`} className="cursor-pointer">
                  <TableCell className="whitespace-nowrap">
                    <button
                      type="button"
                      className="rounded-sm text-start hover:underline focus-visible:outline-none focus-visible:ring-2"
                      aria-label={t('openDetail', { method: item.method, path: item.path })}
                      onClick={() => {
                        onOpen(item);
                      }}
                    >
                      <FormattedDateTime value={item.ts} />
                    </button>
                  </TableCell>
                  <TableCell>
                    {item.apiId && item.apiName ? (
                      <Link href={`/apis/${item.apiId}`} dir="auto" className="hover:underline">
                        {item.apiName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{'—'}</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[24rem]">
                    <span className="flex min-w-0 items-center gap-2">
                      <MethodBadge method={item.method} />
                      <span dir="ltr" className="truncate font-mono text-xs" title={item.path}>
                        {item.path}
                      </span>
                      {(item.reqTruncated || item.resTruncated) && (
                        <Badge variant="muted" title={t('truncatedHint')}>
                          {t('truncatedBadge')}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{fmt.ms(item.latencyMs)}</TableCell>
                  <TableCell dir="ltr" className="font-mono text-xs">
                    {item.keyAlias || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {hasMore && (
            <div className="flex justify-center pt-3">
              <Button type="button" variant="outline" disabled={isFetchingMore} onClick={onLoadMore}>
                {isFetchingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
