/**
 * The wire format of a traffic search: a time window plus a list of typed clauses. The client never
 * sends SQL, column names or operators the server did not enumerate here — `validateSearchRequest`
 * rejects anything else — and the tenant scope is added by the query builder, not by a clause.
 *
 * Lean core: structured filters, headers, and word/phrase search over the bodies. Substring, regular
 * expression and JSON-field search were measured and left out (see `docs/ANALYTICS-PIPELINE.md`).
 */

export const SEARCH_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type SearchRange = (typeof SEARCH_RANGES)[number];

export const SEARCH_LIMITS = {
  /** Clauses per search: each one is another index probe or filter. */
  maxClauses: 8,
  /** Body-text clauses per search: each one runs a full-text probe over large documents. */
  maxBodyClauses: 3,
  /** Shortest body/path term, in letters or digits. */
  minTerm: 3,
  maxValueLength: 200,
  maxPageSize: 100,
  defaultPageSize: 50,
  maxMethods: 7,
  maxStatusValues: 10,
} as const;

/**
 * Words that appear in almost every captured body. A search for one matches nearly every row and
 * runs until the statement timeout (measured: the word `id` was cancelled at 3 s over 30 days).
 */
export const SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
  'id',
  'data',
  'name',
  'value',
  'true',
  'false',
  'null',
  'type',
  'status',
  'message',
]);

export type CompareOp = '>' | '>=' | '<' | '<=';

export type StatusMatch =
  | { type: 'cmp'; op: CompareOp; value: number }
  | { type: 'range'; from: number; to: number }
  | { type: 'in'; values: number[] };

export type SearchClause = { neg: boolean } & (
  | { kind: 'status'; match: StatusMatch }
  | { kind: 'latency'; op: CompareOp; value: number }
  | { kind: 'method'; values: string[] }
  /** The request path starts with `value`. */
  | { kind: 'path'; value: string }
  /** The request path IS `value`: one endpoint of an API, however short its path. */
  | { kind: 'route'; value: string }
  /** An API of the caller's tenant, by name, slug or id. */
  | { kind: 'api'; value: string }
  | { kind: 'key'; value: string }
  /** `value` omitted: the header exists. Names are lower-case. */
  | { kind: 'header'; side: 'req' | 'res'; name: string; value?: string }
  /** The words of `value`, in order, anywhere in the chosen body (full-text, no stemming). */
  | { kind: 'body'; side: 'req' | 'res' | 'any'; value: string }
);

export interface SearchCursor {
  /** ISO timestamp of the last row of the previous page. */
  ts: string;
  id: string;
}

export interface TrafficSearchRequest {
  range: SearchRange;
  clauses: SearchClause[];
  limit: number;
  cursor?: SearchCursor;
}
