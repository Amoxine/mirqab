/**
 * The wire format of a traffic search: a time window plus a list of typed clauses. The client never
 * sends SQL, column names or operators the server did not enumerate here — `validateSearchClauses`
 * rejects anything else — and the tenant scope is added by the query builder, not by a clause.
 */

export const SEARCH_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type SearchRange = (typeof SEARCH_RANGES)[number];

export const SEARCH_LIMITS = {
  /** Clauses per search: each one is another index probe or filter. */
  maxClauses: 8,
  /** Shortest body/path term. A 1-2 character substring scans the whole window. */
  minTerm: 3,
  maxValueLength: 200,
  maxJsonDepth: 6,
  maxPageSize: 100,
  defaultPageSize: 50,
  maxMethods: 7,
  maxStatusValues: 10,
} as const;

export type CompareOp = '>' | '>=' | '<' | '<=';

export type StatusMatch =
  | { type: 'cmp'; op: CompareOp; value: number }
  | { type: 'range'; from: number; to: number }
  | { type: 'in'; values: number[] };

export type SearchClause = { neg: boolean } & (
  | { kind: 'status'; match: StatusMatch }
  | { kind: 'latency'; op: CompareOp; value: number }
  | { kind: 'method'; values: string[] }
  /** `prefix`: starts with `value`. `glob`: `*` matches any run of characters. */
  | { kind: 'path'; mode: 'prefix' | 'glob'; value: string }
  /** An API of the caller's tenant, by name, slug or id. */
  | { kind: 'api'; value: string }
  | { kind: 'key'; value: string }
  /** `value` omitted: the header exists. Names are lower-case. */
  | { kind: 'header'; side: 'req' | 'res'; name: string; value?: string }
  /** `word`: whole words in order (full-text). `substring`: any run of characters (trigram). */
  | { kind: 'body'; side: 'req' | 'res' | 'any'; mode: 'word' | 'substring'; value: string }
  /** A field of a JSON response body; `value` matches a string or a number. */
  | { kind: 'json'; path: string[]; value: string }
  | { kind: 'regex'; value: string }
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
