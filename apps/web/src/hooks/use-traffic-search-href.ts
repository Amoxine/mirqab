import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCanSearchRequests } from '@/hooks/use-can-search-requests';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { trafficFiltersToSearchHref } from '@/lib/traffic-filters-to-query';
import type { AnalyticsKeyRow, TrafficFilters } from '@/types';

/**
 * Builds the link from the traffic page to request search for its current filters. `override` swaps
 * filters for a figure that is about something narrower (an endpoint's own method and path), `extra`
 * adds tokens that are not filters (`status:>=400` for an error figure).
 *
 * The traffic filter holds a key's id and a search clause its name, so a key's name is looked up among
 * the analytics keys: the same request, and cache entry, as `useAnalyticsKeys` (the search page names
 * keys from it too), which needs only `analytics:read` and covers every key, where the key list needs
 * `key:read` and shows a first page. It is only asked for when the user can search at all. A key it
 * cannot name, or whose name another key shares (names are not unique, and a `key:` clause matches the
 * name, so the search would list both keys' requests), is left out of the search.
 *
 * Returns undefined for someone who cannot open search, so nothing links to a no-access page.
 */
export function useTrafficSearchHref(filters: TrafficFilters) {
  const canSearch = useCanSearchRequests();
  const keys = useQuery({
    queryKey: queryKeys.analytics.keys(filters.range),
    queryFn: () => api.get<AnalyticsKeyRow[]>(`/analytics/keys?range=${filters.range}`).then((res) => res.data),
    enabled: canSearch,
  });
  const keyRows = keys.data;

  return useCallback(
    (override: Partial<TrafficFilters> = {}, extra: readonly (string | null)[] = []) =>
      canSearch
        ? trafficFiltersToSearchHref(
            { ...filters, ...override },
            {
              keyName: (id) => {
                const name = keyRows?.find((key) => key.apiKeyId === id)?.name;
                return name !== undefined && keyRows?.filter((key) => key.name === name).length === 1 ? name : undefined;
              },
            },
            extra,
          )
        : undefined,
    [canSearch, filters, keyRows],
  );
}
