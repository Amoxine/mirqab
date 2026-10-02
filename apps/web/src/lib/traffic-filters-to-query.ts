import { SEARCH_LIMITS, parseToken, quoteValue } from '@/lib/traffic-search';
import type { AnalyticsRange, TrafficFilters } from '@/types';

/**
 * The links between the analytics pages. Every figure on the dashboard, analytics and traffic pages
 * opens the list that produced it: the traffic page (filters in its own URL) or request search (its
 * filters are the `?q=` text). Pure, so the mapping is tested without a browser.
 */

/**
 * What the API accepts for an exact status and a minimum latency (`AnalyticsTrafficQueryDto`); anything
 * else is a 400, and the URL can hold any number, so a link built from it must not carry the rest.
 */
const STATUS_RANGE = { min: 100, max: 599 } as const;
const MAX_LATENCY_MS = 600_000;

/** Same default as `useTrafficFilters` and `useSearchQuery`: a link to it carries no `range`. */
const DEFAULT_RANGE: AnalyticsRange = '24h';

export interface FilterQueryContext {
  /** A key's name from its id (the traffic filter holds the id, a `key:` clause the name); undefined when unknown. */
  keyName?: (keyId: string) => string | undefined;
}

/**
 * `field:value` as the search bar reads it (negated with a leading `-`), or null when it cannot be
 * written (`quoteValue`) or the bar would refuse it (a path under 3 letters, a malformed status). A
 * token that is returned is therefore always one the search page accepts.
 */
export function searchToken(field: string, value: string, neg = false): string | null {
  const quoted = quoteValue(value);
  if (quoted === null) return null;
  const token = `${neg ? '-' : ''}${field}:${quoted}`;
  return parseToken(token).ok ? token : null;
}

const present = (token: string | null): token is string => token !== null;

/**
 * The traffic filters as search tokens. What search cannot say is left out rather than approximated:
 * `auth` (no clause matches "has / has no key"), a key whose name is unknown, and a path that is not
 * rooted: the traffic filter is a substring match, but `path:` is a PREFIX of a path that always
 * starts with "/", so `orders` would match nothing.
 */
function filterTokens(filters: TrafficFilters, ctx: FilterQueryContext): string[] {
  const tokens: (string | null)[] = [];
  if (filters.apiId) tokens.push(searchToken('api', filters.apiId));
  const keyName = filters.keyId ? ctx.keyName?.(filters.keyId) : undefined;
  if (keyName) tokens.push(searchToken('key', keyName));
  if (filters.method) tokens.push(searchToken('method', filters.method));
  if (filters.statusClass) tokens.push(searchToken('status', filters.statusClass));
  if (filters.status !== undefined && filters.status >= STATUS_RANGE.min && filters.status <= STATUS_RANGE.max)
    tokens.push(searchToken('status', String(filters.status)));
  if (filters.path?.startsWith('/')) tokens.push(searchToken('path', filters.path));
  if (filters.minLatencyMs !== undefined && filters.minLatencyMs > 0 && filters.minLatencyMs <= MAX_LATENCY_MS)
    tokens.push(searchToken('latency', `>=${String(filters.minLatencyMs)}`));
  return tokens.filter(present);
}

/** The `q` text of `/analytics/search` for the traffic page's current filters. */
export function trafficFiltersToSearchQuery(filters: TrafficFilters, ctx: FilterQueryContext = {}): string {
  return filterTokens(filters, ctx).join(' ');
}

/**
 * The tokens that pick out one endpoint's requests: its EXACT path (`route:`, because an endpoint table
 * groups by the whole path, where `path:` is a prefix and would also list /orders/42), its method, and
 * the API when the view is narrowed to one. `null` when any of them cannot be written (a path with a
 * double quote or a line break): leaving that one out would list MORE than the row counts, so the
 * caller shows the row without a link instead.
 */
export function endpointTokens(endpoint: { method: string; path: string }, apiId?: string): string[] | null {
  const tokens = [
    ...(apiId ? [searchToken('api', apiId)] : []),
    searchToken('route', endpoint.path),
    searchToken('method', endpoint.method),
  ];
  return tokens.every(present) ? tokens : null;
}

/**
 * The codes the status breakdown reports on their own. Its "4xx" and "5xx" rows are the REMAINDER
 * of their class (every other code), so selecting one has to leave these out; `status:4xx` alone
 * would count them too and the list would be longer than the figure it was opened from.
 */
const LISTED_CODES: Partial<Record<string, string>> = {
  '4xx': '400,401,403,404,429',
  '5xx': '500,502,503,504',
};

/** The search tokens for one row of the status-code breakdown (`2xx`, `401`, `4xx`...). */
export function statusCodeTokens(code: string): (string | null)[] {
  const listed = LISTED_CODES[code];
  return listed === undefined
    ? [searchToken('status', code)]
    : [searchToken('status', code), searchToken('status', listed, true)];
}

/** `/analytics/search` for these tokens and range (the range is dropped when it is the default, like the page does). */
export function searchHref(tokens: readonly (string | null)[], range: AnalyticsRange): string {
  const params = new URLSearchParams();
  const q = tokens.filter(present).join(' ');
  if (q) params.set('q', q);
  if (range !== DEFAULT_RANGE) params.set('range', range);
  const query = params.toString();
  return query ? `/analytics/search?${query}` : '/analytics/search';
}

/**
 * `/analytics/search` for the current traffic filters plus tile-specific tokens (`status:>=400` for
 * an error figure). The search bar caps its clauses, so when the two do not fit the extras stay and
 * the last filters go: the extras are what the clicked figure is about.
 */
export function trafficFiltersToSearchHref(
  filters: TrafficFilters,
  ctx: FilterQueryContext = {},
  extra: readonly (string | null)[] = [],
): string {
  const tokens = extra.filter(present);
  const room = Math.max(0, SEARCH_LIMITS.maxClauses - tokens.length);
  return searchHref([...filterTokens(filters, ctx).slice(0, room), ...tokens], filters.range);
}

/** `/analytics/traffic` with these filters, named as `parseTrafficFilters` reads them. */
export function trafficHref(filters: Partial<TrafficFilters> & Pick<TrafficFilters, 'range'>): string {
  const params = new URLSearchParams();
  // A caller may pass a filter explicitly as undefined ("not set"), which the entries' type leaves out.
  const entries: [string, string | number | undefined][] = Object.entries(filters);
  for (const [key, value] of entries) {
    if (key !== 'range' && value !== undefined && value !== '') params.set(key, String(value));
  }
  if (filters.range !== DEFAULT_RANGE) params.set('range', filters.range);
  const query = params.toString();
  return query ? `/analytics/traffic?${query}` : '/analytics/traffic';
}
