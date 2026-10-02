'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { passToRowLink } from '@open-gateway/ui';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { FormattedDateTime } from '@/components/shared/formatted';
import { RowLink, rowLinkProps } from '@/components/shared/row-link';
import { StateMessage } from '@/components/shared/state-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormat } from '@/hooks/use-format';
import { usePermissions } from '@/hooks/use-permissions';
import { useSettledText } from '@/hooks/use-settled-text';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { ApiRequestError } from '@/lib/api-client';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { focusReturn } from '@/lib/focus-return';
import { statusVariant } from '@/lib/http-status';
import { searchRequestKey } from '@/lib/search-target';
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
  filterCount,
  indexedUntil,
  onLoadMore,
  onRetry,
  onOpen,
  getHref,
}: {
  items: TrafficSearchItem[];
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | null;
  hasMore: boolean;
  isFetchingMore: boolean;
  hasFilters: boolean;
  /** How many filters the search holds: part of what the count announcement says, so changing one is heard. */
  filterCount: number;
  indexedUntil: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  /** Opens a result's sheet in place (a plain click). */
  onOpen: (item: TrafficSearchItem) => void;
  /** The page's address with a result open: what a new tab (a modified or middle click) loads. */
  getHref: (item: TrafficSearchItem) => string;
}) {
  const t = useTranslations('analytics.search');
  const fmt = useFormat();
  const { can } = usePermissions();
  const locale = dateFnsLocale(useLocale() as Locale);

  // "Load more" appends rows below the button the user is on: focus goes to the first new row, so a
  // keyboard user carries on where the new results begin instead of being left at the old bottom.
  const loading = useRef<{ from: number; started: boolean } | null>(null);
  useEffect(() => {
    const pending = loading.current;
    if (!pending) return;
    if (isFetchingMore) {
      pending.started = true;
      return;
    }
    const first = items[pending.from] as TrafficSearchItem | undefined;
    if (first) focusReturn(searchRequestKey(first));
    // Done when rows arrived, or when the fetch ran and ended without any (it failed).
    if (first || pending.started) loading.current = null;
  }, [items, isFetchingMore]);

  const freshness =
    indexedUntil === null
      ? t('notIndexedYet')
      : t('indexedUntil', { when: formatDistanceToNow(new Date(indexedUntil), { addSuffix: true, locale }) });

  // What the live region says, so adding or removing a filter is heard. Only a settled result is
  // ever said: while a changed search loads (the stale rows are still on screen) or it fails, the
  // region keeps its last words, and an unchanged text is not touched, so a background refetch that
  // brings the same count is silent. The index freshness is deliberately NOT in the region: it moves
  // on every refetch and would be read out each time.
  const announced = useSettledText(
    t('resultCount', { count: items.length, filters: filterCount }),
    !isLoading && !isRefetching && error === null,
  );

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
      <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-xs">
        <span role="status" className="text-foreground font-medium">
          {announced}
        </span>
        <span>{`${freshness} · ${t('coverage')}`}</span>
      </div>
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
                <TableRow
                  key={`${item.ts}-${item.id}`}
                  // A plain click on the row's own space opens the result in place, after a short wait for a
                  // possible second click, so a path or a key can still be double-clicked, triple-clicked or
                  // dragged to copy. The hidden link is that result's address: Ctrl, Cmd, Shift or a middle
                  // click opens it in a new tab, as for every other list's rows.
                  {...rowLinkProps(undefined, () => {
                    onOpen(item);
                  })}
                >
                  <TableCell className="whitespace-nowrap">
                    <RowLink href={getHref(item)} />
                    <button
                      type="button"
                      className="rounded-sm text-start hover:underline focus-visible:outline-hidden focus-visible:ring-2"
                      // Where focus returns to when this result's sheet closes (it may have been opened by a click on text).
                      data-focus-return={searchRequestKey(item)}
                      // The time is the way in for the keyboard and a pointer alike: a modified or middle click
                      // on it goes to the row's link (a new tab) and does not also open the sheet in this one.
                      onClick={(event) => {
                        if (!passToRowLink(event)) onOpen(item);
                      }}
                      onAuxClick={(event) => {
                        passToRowLink(event);
                      }}
                    >
                      <FormattedDateTime value={item.ts} />
                      {/* Not an aria-label: that would replace the visible time in the name. */}
                      <span className="sr-only">{t('openDetail', { method: item.method, path: item.path })}</span>
                    </button>
                  </TableCell>
                  {/* Capped, so one long unbroken name cannot stretch the table past its scroller. */}
                  <TableCell className="max-w-[16rem]">
                    {item.apiId && item.apiName ? (
                      can('api:read') ? (
                        <Link
                          href={`/apis/${item.apiId}`}
                          dir="auto"
                          title={item.apiName}
                          className="inline-block max-w-full truncate align-bottom hover:underline"
                        >
                          {item.apiName}
                        </Link>
                      ) : (
                        <span dir="auto" title={item.apiName} className="block truncate">
                          {item.apiName}
                        </span>
                      )
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
                  <TableCell className="whitespace-nowrap text-end tabular-nums">{fmt.ms(item.latencyMs)}</TableCell>
                  {/* One line: a key name is cut with an ellipsis (its full text is the tooltip), never wrapped or clipped mid-letter. */}
                  <TableCell dir="ltr" className="max-w-[12rem] font-mono text-xs">
                    <span className="block truncate" title={item.keyAlias || undefined}>
                      {item.keyAlias || '—'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {hasMore && (
            <div className="flex justify-center pt-3">
              <Button
                type="button"
                variant="outline"
                disabled={isFetchingMore}
                onClick={() => {
                  loading.current = { from: items.length, started: false };
                  onLoadMore();
                }}
              >
                {isFetchingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
