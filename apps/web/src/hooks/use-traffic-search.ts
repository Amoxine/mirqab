import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { SearchClause } from '@/lib/traffic-search';
import type { AnalyticsRange } from '@/types';

const SEARCH_PAGE_SIZE = 50;
const SEARCH_STALE_MS = 5 * 60_000;

/** Mirrors `TrafficSearchItem` in `apps/api/src/modules/analytics/search/traffic-search.service.ts`. */
export interface TrafficSearchItem {
  id: string;
  /** ISO-8601 UTC with microseconds: also the keyset cursor's timestamp. */
  ts: string;
  apiId: string | null;
  apiName: string | null;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  keyAlias: string;
  /** The body was cut at 16 KiB before it was indexed, so a search only saw the part that was kept. */
  reqTruncated: boolean;
  resTruncated: boolean;
}

export interface TrafficSearchCursor {
  ts: string;
  id: string;
}

export interface TrafficSearchPage {
  range: AnalyticsRange;
  items: TrafficSearchItem[];
  hasMore: boolean;
  nextCursor: TrafficSearchCursor | null;
  /** How far the indexer has caught up; an empty result before this instant is real. */
  indexedUntil: string | null;
  /** The earliest instant the index covers. Optional: an API image from before the field existed does not send it. */
  indexedFrom?: string | null;
  /** Whether the index covers the whole window (`complete`), part of it (`partial`) or nothing yet (`none`). */
  coverage?: 'complete' | 'partial' | 'none';
}

export interface TrafficSearchDetail extends TrafficSearchItem {
  ip: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string;
  resBody: string;
}

/**
 * Captured-request search, one page at a time. The clauses are the parsed search bar; the server
 * validates them again. `keepPreviousData` keeps the old rows on screen (dimmed) while a changed search loads.
 */
export function useTrafficSearch(range: AnalyticsRange, clauses: SearchClause[], enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.analytics.search({ range, clauses }),
    queryFn: ({ pageParam, signal }) =>
      api
        .post<TrafficSearchPage>(
          '/analytics/traffic/search',
          {
            range,
            clauses,
            limit: SEARCH_PAGE_SIZE,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          // A search that is no longer wanted (the query was cancelled, or the page left) stops at the network
          // instead of running on and counting against the per-tenant limit of two in flight.
          { signal },
        )
        .then((res) => res.data),
    initialPageParam: null as TrafficSearchCursor | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled,
    // A loaded infinite query re-runs EVERY page, one after the other, once it is stale. Each page is a search the
    // server throttles (20 a minute) and allows two of at a time, so for this query only: not stale for five
    // minutes (the app default is one), and no refetch of all pages just because the window gained focus. The
    // search page's own filters and the index notice are what bring a changed result in.
    staleTime: SEARCH_STALE_MS,
    refetchOnWindowFocus: false,
    // A 400 or 422 will not change on retry; only a dropped connection is worth another try.
    retry: false,
  });
}

/** One result with its headers and bodies; `ts` is the result's own, so the server opens one partition. */
export function useTrafficSearchDetail(item: Pick<TrafficSearchItem, 'id' | 'ts'> | null) {
  return useQuery({
    queryKey: queryKeys.analytics.searchDetail(item?.id ?? '', item?.ts ?? ''),
    queryFn: () =>
      api
        .get<TrafficSearchDetail>(`/analytics/traffic/search/${item?.id ?? ''}?ts=${encodeURIComponent(item?.ts ?? '')}`)
        .then((res) => res.data),
    enabled: item !== null,
    retry: false,
  });
}
