import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { SearchClause } from '@/lib/traffic-search';
import type { AnalyticsRange } from '@/types';

const SEARCH_PAGE_SIZE = 50;

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
    queryFn: ({ pageParam }) =>
      api
        .post<TrafficSearchPage>('/analytics/traffic/search', {
          range,
          clauses,
          limit: SEARCH_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        })
        .then((res) => res.data),
    initialPageParam: null as TrafficSearchCursor | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled,
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
