import { parseHttpDump, type HttpDump } from '../services/http-dump-parser';

/** What `tyk_analytics` gives for one captured request (the pump table, before any redaction by this module). */
export interface CapturedRow {
  /** `"timestamp"` as ISO-8601 UTC text with microseconds: a JS `Date` would round it to milliseconds. */
  ts_iso: string;
  apiid: string;
  apikey: string | null;
  alias: string | null;
  ipaddress: string | null;
  method: string | null;
  path: string | null;
  responsecode: bigint | number | null;
  latency_total: bigint | number | null;
  rawrequest: string | null;
  rawresponse: string | null;
  /** sha256 of the row's identifying columns, computed in SQL so it is stable across runs. */
  dedupe_key: string;
}

/** One row of `og_traffic_search`. Every text field here has been through `parseHttpDump`. */
export interface SearchRow {
  ts: string;
  apiid: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  keyAlias: string;
  ip: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string;
  resBody: string;
  reqTruncated: boolean;
  resTruncated: boolean;
  dedupeKey: string;
}

/** Stored instead of a multipart body: the parser does not understand boundaries, so its redaction cannot be trusted there. */
export const MULTIPART_PLACEHOLDER = '[multipart body not indexed]';

/** A header value longer than this is cut: it bounds the GIN index, and a search for one is not a real use. */
const MAX_HEADER_VALUE = 1000;
const MAX_HEADER_NAME = 100;

const num = (v: bigint | number | null): number => (v === null ? 0 : Number(v));

/** Lower-case names (`header:` clauses match lower-case), bounded, and safe for a header called `__proto__`. */
function headersOf(dump: HttpDump | null): Record<string, string> {
  if (!dump) return {};
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(dump.headers)) {
    out.set(name.toLowerCase().slice(0, MAX_HEADER_NAME), value.slice(0, MAX_HEADER_VALUE));
  }
  return Object.fromEntries(out);
}

function bodyOf(dump: HttpDump | null, headers: Record<string, string>): string {
  if (!dump) return '';
  return /^multipart\//i.test(headers['content-type'] ?? '') ? MULTIPART_PLACEHOLDER : dump.body;
}

/**
 * One captured request as a searchable row. Runs both dumps through the same parser the traffic
 * inspector displays with (`authHeaderName` included), so what is searchable is exactly what a person
 * could already see, and a secret that is redacted on screen cannot be found by searching for it.
 */
export function buildSearchRow(row: CapturedRow, authHeaderName: string | null): SearchRow {
  const request = parseHttpDump(row.rawrequest, { authHeaderName });
  const response = parseHttpDump(row.rawresponse, { authHeaderName });
  const reqHeaders = headersOf(request);
  const resHeaders = headersOf(response);
  return {
    ts: row.ts_iso,
    apiid: row.apiid,
    method: row.method ?? '',
    path: row.path ?? '',
    status: num(row.responsecode),
    latencyMs: num(row.latency_total),
    keyAlias: row.alias ?? '',
    ip: row.ipaddress ?? '',
    reqHeaders,
    resHeaders,
    reqBody: bodyOf(request, reqHeaders),
    resBody: bodyOf(response, resHeaders),
    reqTruncated: request?.truncated ?? false,
    resTruncated: response?.truncated ?? false,
    dedupeKey: row.dedupe_key,
  };
}
