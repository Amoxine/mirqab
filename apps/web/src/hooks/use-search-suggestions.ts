import { useQuery } from '@tanstack/react-query';
import { trafficQuery } from '@/hooks/use-analytics';
import type { SearchToken } from '@/hooks/use-search-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { valueField, type SuggestContext } from '@/lib/traffic-search-suggest';
import type { AnalyticsApiRow, AnalyticsKeyRow, AnalyticsRange, AnalyticsTraffic } from '@/types';

/**
 * Rows asked of `/analytics/apis` and `/analytics/keys`: the most the API allows (`MAX_LIST_LIMIT`; the default
 * is 50). Past it a name is not suggested, which costs nothing for a key (typing it works) and is handled for
 * an API below. These endpoints need only `analytics:read`, which the page already requires; the plain
 * `/apis` and `/keys` lists need `api:read` and `key:read` on top, and also page at 100.
 */
const LIST_LIMIT = 100;

interface ApiOption {
  id: string;
  slug: string;
  name: string;
}

// Module-level, so the cache hands back the same arrays until the data changes.
const toApiOptions = (rows: AnalyticsApiRow[]): ApiOption[] => rows.map(({ apiDefId, slug, name }) => ({ id: apiDefId, slug, name }));
const toKeyOptions = (rows: AnalyticsKeyRow[]) => rows.map(({ name, apiDefName }) => ({ name, apiName: apiDefName }));
/** One endpoint per path, whatever the methods. */
const toPaths = (traffic: AnalyticsTraffic): string[] => [...new Set(traffic.topEndpoints.map((endpoint) => endpoint.path))];

/** The API the search is already narrowed to: the first `api:` chip that does not exclude. */
function scopedApi(tokens: SearchToken[]): string | null {
  for (const { parsed } of tokens) {
    if (parsed.ok && parsed.clause.kind === 'api' && !parsed.clause.neg) return parsed.clause.value;
  }
  return null;
}

/**
 * The lists the dropdown draws values from, fetched only while the filter being typed needs one: `api:`
 * the APIs, `key:` the keys, `path:` and `route:` the busiest endpoints (of the API already filtered on, if any). The
 * app-wide `staleTime` means typing, or switching fields and back, does not ask again. A request that
 * fails (once: `retry: false`) leaves its list `undefined`, which the dropdown treats as "nothing to
 * suggest": no error is shown.
 */
export function useSearchSuggestions(
  draft: string,
  tokens: SearchToken[],
  range: AnalyticsRange,
): Pick<SuggestContext, 'apis' | 'keys' | 'paths'> {
  const field = valueField(draft);
  const pathField = field === 'path' || field === 'route';
  const scope = scopedApi(tokens);

  const apis = useQuery({
    // Its own entry: the dashboard's `useAnalyticsApis(range)` caches the default 50 rows under the plain key.
    queryKey: [...queryKeys.analytics.apis(range), 'suggest'],
    queryFn: () => api.get<AnalyticsApiRow[]>(`/analytics/apis?range=${range}&limit=${String(LIST_LIMIT)}`).then((res) => res.data),
    select: toApiOptions,
    enabled: field === 'api' || (pathField && scope !== null),
    retry: false,
  });
  const keys = useQuery({
    queryKey: [...queryKeys.analytics.keys(range), 'suggest'],
    queryFn: () => api.get<AnalyticsKeyRow[]>(`/analytics/keys?range=${range}&limit=${String(LIST_LIMIT)}`).then((res) => res.data),
    select: toKeyOptions,
    enabled: field === 'key',
    retry: false,
  });

  // Paths for the API already filtered on, found the way the server finds it: id, or name or slug in any case.
  // One match scopes them. Several (two APIs share a name), none in a list that is full (the API may lie past its
  // end) or a list that did not load fall back to every path, a superset. None in a complete list is an API that
  // does not exist: no paths.
  const needle = scope?.toLowerCase();
  const matches = apis.data?.filter((row) => row.id === scope || [row.slug, row.name].some((v) => typeof v === 'string' && v.toLowerCase() === needle)) ?? [];
  const listFull = (apis.data?.length ?? 0) >= LIST_LIMIT;
  const apiId = matches.length === 1 ? matches[0]?.id : undefined;
  const pathsWanted = pathField && (scope === null || apis.isError || (apis.data !== undefined && (matches.length > 0 || listFull)));
  const traffic = useQuery({
    ...trafficQuery({ range, apiId }),
    select: toPaths,
    enabled: pathsWanted,
    retry: false,
  });

  return {
    apis: apis.data,
    keys: keys.data,
    // A cached answer for another scope must not outlive the reason it was asked.
    paths: pathsWanted ? traffic.data : undefined,
  };
}
