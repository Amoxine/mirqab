import { Prisma } from '@prisma/client';
import {
  UNAUTHENTICATED_KEY_HASH,
  type AnalyticsWindow,
  type SqlNumeric,
} from './pump-query.builder';

/**
 * SQL for the filtered traffic view (`GET /analytics/traffic`). Every filter — method, path, status,
 * key, latency — lives only on the raw per-request table, so unlike the overview this always reads
 * `tyk_analytics` (bounded by its retention, `ANALYTICS_RETENTION_DAYS`). Values are bound
 * parameters; the only interpolated pieces are fixed SQL fragments chosen from closed enums.
 */

export const TRAFFIC_STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
export type TrafficStatusClass = (typeof TRAFFIC_STATUS_CLASSES)[number];

export const TRAFFIC_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

/** Rows kept from the endpoint rollup: enough to show the busiest 10 and pick the slowest 10 among them. */
export const TRAFFIC_ENDPOINT_POOL = 50;

export interface TrafficFilters {
  /** The tenant's own Tyk API ids, or a single one when the caller filtered by API. */
  tykApiIds: string[];
  /** One key hash, when the caller filtered by key. */
  keyHash?: string;
  method?: string;
  statusClass?: TrafficStatusClass;
  status?: number;
  /** Substring of the request path, matched case-insensitively. */
  path?: string;
  minLatencyMs?: number;
  auth?: 'authenticated' | 'anonymous';
}

/** Escapes `\`, `%` and `_` so a user-typed path is matched literally by `ILIKE ... ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const CLASS_BOUNDS: Record<TrafficStatusClass, [number, number]> = {
  '2xx': [200, 300],
  '3xx': [300, 400],
  '4xx': [400, 500],
  '5xx': [500, 600],
};

/** WHERE clause shared by every traffic query: tenant scope + window + the caller's filters. */
export function trafficWhere(window: AnalyticsWindow, f: TrafficFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`apiid = ANY(${f.tykApiIds}::text[])`,
    Prisma.sql`"timestamp" >= ${window.from}`,
  ];
  if (f.keyHash) parts.push(Prisma.sql`apikey = ${f.keyHash}`);
  if (f.method) parts.push(Prisma.sql`method = ${f.method}`);
  if (f.status !== undefined) parts.push(Prisma.sql`responsecode = ${f.status}`);
  if (f.statusClass) {
    const [lo, hi] = CLASS_BOUNDS[f.statusClass];
    parts.push(Prisma.sql`responsecode >= ${lo} AND responsecode < ${hi}`);
  }
  if (f.path) parts.push(Prisma.sql`path ILIKE ${`%${escapeLike(f.path)}%`} ESCAPE '\\'`);
  if (f.minLatencyMs !== undefined) parts.push(Prisma.sql`latency_total >= ${f.minLatencyMs}`);
  if (f.auth === 'anonymous') parts.push(Prisma.sql`apikey = ${UNAUTHENTICATED_KEY_HASH}`);
  if (f.auth === 'authenticated') parts.push(Prisma.sql`apikey <> ${UNAUTHENTICATED_KEY_HASH}`);
  return Prisma.join(parts, ' AND ');
}

export interface TrafficSummaryRow {
  requests: SqlNumeric;
  errors: SqlNumeric;
  client_errors: SqlNumeric;
  server_errors: SqlNumeric;
  avg_latency_ms: SqlNumeric;
  avg_upstream_ms: SqlNumeric;
  p50: SqlNumeric;
  p95: SqlNumeric;
  p99: SqlNumeric;
  unique_clients: SqlNumeric;
  unique_keys: SqlNumeric;
  anonymous: SqlNumeric;
  bytes_in: SqlNumeric;
  last_request_at: Date | null;
}

export function trafficSummaryQuery(window: AnalyticsWindow, f: TrafficFilters): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint                                                   AS requests,
           COUNT(*) FILTER (WHERE responsecode >= 400)::bigint                AS errors,
           COUNT(*) FILTER (WHERE responsecode >= 400 AND responsecode < 500)::bigint AS client_errors,
           COUNT(*) FILTER (WHERE responsecode >= 500)::bigint                AS server_errors,
           AVG(latency_total)::numeric                                        AS avg_latency_ms,
           AVG(latency_upstream)::numeric                                     AS avg_upstream_ms,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_total)        AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_total)        AS p95,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_total)        AS p99,
           COUNT(DISTINCT ipaddress)::bigint                                  AS unique_clients,
           COUNT(DISTINCT apikey) FILTER (WHERE apikey <> ${UNAUTHENTICATED_KEY_HASH})::bigint AS unique_keys,
           COUNT(*) FILTER (WHERE apikey = ${UNAUTHENTICATED_KEY_HASH})::bigint AS anonymous,
           COALESCE(SUM(contentlength) FILTER (WHERE contentlength > 0), 0)::bigint AS bytes_in,
           MAX("timestamp")                                                   AS last_request_at
    FROM public.tyk_analytics
    WHERE ${trafficWhere(window, f)}
  `;
}

export interface TrafficBucketRow {
  bucket_epoch: SqlNumeric;
  requests: SqlNumeric;
  errors: SqlNumeric;
  avg_latency_ms: SqlNumeric;
  p95: SqlNumeric;
}

/** Newest `limit` buckets, oldest first — same rule as the overview chart's cap. */
export function trafficTimeSeriesQuery(
  window: AnalyticsWindow,
  f: TrafficFilters,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT bucket_epoch, requests, errors, avg_latency_ms, p95
    FROM (
      SELECT EXTRACT(EPOCH FROM date_trunc(${window.bucket}::text, "timestamp" AT TIME ZONE 'UTC'))::bigint AS bucket_epoch,
             COUNT(*)::bigint                                          AS requests,
             COUNT(*) FILTER (WHERE responsecode >= 400)::bigint       AS errors,
             AVG(latency_total)::numeric                               AS avg_latency_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_total) AS p95
      FROM public.tyk_analytics
      WHERE ${trafficWhere(window, f)}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${limit}
    ) newest
    ORDER BY bucket_epoch
  `;
}

export interface TrafficStatusRow {
  code: SqlNumeric;
  count: SqlNumeric;
}

/** Exact status codes, most frequent first; the service folds them into classes. */
export function trafficStatusQuery(window: AnalyticsWindow, f: TrafficFilters): Prisma.Sql {
  return Prisma.sql`
    SELECT responsecode AS code, COUNT(*)::bigint AS count
    FROM public.tyk_analytics
    WHERE ${trafficWhere(window, f)}
    GROUP BY responsecode
    ORDER BY count DESC
    LIMIT 40
  `;
}

export interface TrafficMethodRow {
  method: string;
  count: SqlNumeric;
}

export function trafficMethodQuery(window: AnalyticsWindow, f: TrafficFilters): Prisma.Sql {
  return Prisma.sql`
    SELECT method, COUNT(*)::bigint AS count
    FROM public.tyk_analytics
    WHERE ${trafficWhere(window, f)}
    GROUP BY method
    ORDER BY count DESC
    LIMIT 10
  `;
}

export interface TrafficEndpointRow {
  method: string;
  path: string;
  requests: SqlNumeric;
  errors: SqlNumeric;
  avg_latency_ms: SqlNumeric;
  p95: SqlNumeric;
}

/** The busiest `TRAFFIC_ENDPOINT_POOL` (method, path) pairs with their latency profile. */
export function trafficEndpointQuery(window: AnalyticsWindow, f: TrafficFilters): Prisma.Sql {
  return Prisma.sql`
    SELECT method, path,
           COUNT(*)::bigint                                            AS requests,
           COUNT(*) FILTER (WHERE responsecode >= 400)::bigint         AS errors,
           AVG(latency_total)::numeric                                 AS avg_latency_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_total) AS p95
    FROM public.tyk_analytics
    WHERE ${trafficWhere(window, f)}
    GROUP BY method, path
    ORDER BY requests DESC, path
    LIMIT ${TRAFFIC_ENDPOINT_POOL}
  `;
}
