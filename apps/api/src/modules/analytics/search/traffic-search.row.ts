import { parseHttpDump, redactPairs, type HttpDump } from '../services/http-dump-parser';
import { storable } from '../text-safety';

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
  /** Either dump could not be decoded (gzip, binary), so none of its headers or body were read. */
  unredactable: boolean;
  dedupeKey: string;
}

/** Stored instead of a multipart body: the parser does not understand boundaries, so its redaction cannot be trusted there. */
export const MULTIPART_PLACEHOLDER = '[multipart body not indexed]';

/**
 * Stored instead of a body that is not JSON or a form. The parser reads those two shapes (JSON by key, a
 * form by `name=value`); it does not read `password=x` on its own line, `user=bob password=x`, an XML
 * `<Password>`, a YAML `password: x` or HTML, so anything it leaves readable there would be searchable.
 * An unreadable body is hidden whole, the same decision as multipart.
 */
export const OPAQUE_BODY_PLACEHOLDER = '[body not indexed: its format cannot be redacted]';

/** Stored instead of a capture the trigger could not decode; visible, so the row does not look like an empty request. */
export const UNREDACTABLE_BODY_PLACEHOLDER = '[UNREDACTABLE: non-UTF8 body]';

/** A header value longer than this is cut: it bounds the GIN index, and a search for one is not a real use. */
const MAX_HEADER_VALUE = 1000;
const MAX_HEADER_NAME = 100;

const num = (v: bigint | number | null): number => (v === null ? 0 : Number(v));

/** Lower-case names (`header:` clauses match lower-case), bounded, and safe for a header called `__proto__`. */
function headersOf(dump: HttpDump | null): Record<string, string> {
  if (!dump) return {};
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(dump.headers)) {
    // `slice` counts UTF-16 units and can cut an emoji in half; `storable` repairs the half (it is the poison pill).
    out.set(storable(name.toLowerCase().slice(0, MAX_HEADER_NAME)), storable(value.slice(0, MAX_HEADER_VALUE)));
  }
  return Object.fromEntries(out);
}

/** `application/json; charset=utf-8` -> `application/json`. */
const mediaType = (contentType: string | undefined): string => (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

const isJsonType = (type: string): boolean =>
  type === 'application/json' || type === 'text/json' || type === 'application/x-ndjson' || type.endsWith('+json');

function bodyOf(dump: HttpDump | null, headers: Record<string, string>): string {
  if (!dump) return '';
  if (dump.unredactable) return UNREDACTABLE_BODY_PLACEHOLDER;
  if (dump.body === '') return '';
  const type = mediaType(headers['content-type']);
  if (type.startsWith('multipart/')) return MULTIPART_PLACEHOLDER;
  if (isJsonType(type) || type === 'application/x-www-form-urlencoded') return dump.body;
  // No Content-Type: a body that opens like JSON was read as JSON, anything else is not trusted.
  if (type === '' && /^\s*[{[]/.test(dump.body)) return dump.body;
  return OPAQUE_BODY_PLACEHOLDER;
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
    apiid: storable(row.apiid),
    method: storable(row.method ?? ''),
    // The pump's own `path` column, not a dump: the parser never sees it, so a JWT or a `token=` parameter in it is hidden here.
    path: redactPairs(storable(row.path ?? '')),
    status: num(row.responsecode),
    latencyMs: num(row.latency_total),
    keyAlias: storable(row.alias ?? ''),
    ip: storable(row.ipaddress ?? ''),
    reqHeaders,
    resHeaders,
    reqBody: storable(bodyOf(request, reqHeaders)),
    resBody: storable(bodyOf(response, resHeaders)),
    reqTruncated: request?.truncated ?? false,
    resTruncated: response?.truncated ?? false,
    unredactable: request?.unredactable === true || response?.unredactable === true,
    dedupeKey: row.dedupe_key,
  };
}
