import { Prisma } from '@prisma/client';

/**
 * Parameterised SQL for the Tyk Pump tables (`tyk_analytics`, `tyk_aggregated`).
 *
 * These tables are owned by the pump (gorm AutoMigrate) and are deliberately absent from
 * `schema.prisma`, so every read is a `$queryRaw` with bound parameters. The builders here are pure
 * so the tenant scoping and the two counter gotchas can be unit-tested without a database:
 *
 * 1. Totals come from `counter_hits` / `counter_success` / `counter_error`. The `code_2x` /
 *    `code_200` columns stay 0 even for successful requests — only error codes are populated.
 * 2. `counter_latency` is a per-row average and cannot be averaged across rows; the average latency
 *    is the weighted form `SUM(counter_total_latency) / NULLIF(SUM(counter_hits), 0)`.
 *
 * Tenant scoping (spec D6) is by `apiid` ∈ the tenant's `tykApiId` set — never by `org_id`, which is
 * a single global value for every tenant. `dimension='errors'` and `dimension=''` rows carry no
 * `apiid` and therefore cannot be tenant-scoped at all; they are never queried.
 *
 * Window and time zone. `range=1h` reads the raw table with the exact window start for the rollups
 * AND the chart alike, so totals and chart agree; longer ranges read the hourly aggregate, whose
 * start is floored to the hour bucket. Every time-series bucket is truncated in UTC (never the DB
 * session time zone) and returned as a UTC epoch, so buckets are deterministic UTC instants.
 */

export const ANALYTICS_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type AnalyticsRangeValue = (typeof ANALYTICS_RANGES)[number];

/** Hard cap on time-series rows (spec §4.5). */
export const MAX_TIME_SERIES_BUCKETS = 750;

/** `tyk_analytics.apikey` / `tyk_aggregated.dimension_value` for unauthenticated traffic. */
export const UNAUTHENTICATED_KEY_HASH = '00000000';

const SECONDS_PER_HOUR = 3600;

const RANGE_SECONDS: Record<AnalyticsRangeValue, number> = {
  '1h': SECONDS_PER_HOUR,
  '24h': 24 * SECONDS_PER_HOUR,
  '7d': 7 * 24 * SECONDS_PER_HOUR,
  '30d': 30 * 24 * SECONDS_PER_HOUR,
};

/** Time-series bucket per range (spec §4.4): `1h` reads the raw table, everything else aggregates. */
const RANGE_BUCKET: Record<AnalyticsRangeValue, TimeBucket> = {
  '1h': 'minute',
  '24h': 'hour',
  '7d': 'hour',
  '30d': 'day',
};

export type TimeBucket = 'minute' | 'hour' | 'day';

export interface AnalyticsWindow {
  range: AnalyticsRangeValue;
  /** Exact window start — used against `tyk_analytics."timestamp"` (a real timestamptz). */
  from: Date;
  /**
   * Window start floored to the hour, for `tyk_aggregated."timestamp"` (a bigint epoch holding the
   * *start* of an hourly bucket). Without the flooring the bucket covering `from` would be dropped.
   * Only used when `source === 'aggregate'`; the raw path always uses the exact `from`.
   */
  fromEpochSeconds: number;
  bucket: TimeBucket;
  /** The table every query for this window reads: rollups, status codes and the time series. */
  source: 'raw' | 'aggregate';
}

export function analyticsWindow(range: AnalyticsRangeValue, now: Date = new Date()): AnalyticsWindow {
  const seconds = RANGE_SECONDS[range];
  const fromMs = now.getTime() - seconds * 1000;
  const bucket = RANGE_BUCKET[range];

  return {
    range,
    from: new Date(fromMs),
    fromEpochSeconds: Math.floor(fromMs / 1000 / SECONDS_PER_HOUR) * SECONDS_PER_HOUR,
    bucket,
    source: bucket === 'minute' ? 'raw' : 'aggregate',
  };
}

/** Postgres numeric/bigint columns arrive as Decimal, BigInt or string depending on the cast. */
export type SqlNumeric = number | bigint | string | Prisma.Decimal | null | undefined;

export function toNumber(value: SqlNumeric): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(typeof value === 'string' ? value : value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Percentage 0-100, two decimals — the app-wide representation of an error rate. */
export function errorRatePercent(errors: number, requests: number): number {
  if (requests <= 0) return 0;
  return Math.round((errors / requests) * 10000) / 100;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface RollupRow {
  /** `dimension_value`: a Tyk `api_id` for the API rollup, a key hash for the key rollup. */
  dimension_value: string;
  requests: SqlNumeric;
  success: SqlNumeric;
  errors: SqlNumeric;
  avg_latency_ms: SqlNumeric;
  avg_upstream_ms: SqlNumeric;
}

export interface TimeSeriesRow {
  /** Bucket start as a UTC epoch in seconds. */
  bucket_epoch: SqlNumeric;
  requests: SqlNumeric;
  errors: SqlNumeric;
  avg_latency_ms: SqlNumeric;
}

export interface StatusCodeRow {
  c2xx: SqlNumeric;
  c400: SqlNumeric;
  c401: SqlNumeric;
  c403: SqlNumeric;
  c404: SqlNumeric;
  c429: SqlNumeric;
  c4xx_other: SqlNumeric;
  c500: SqlNumeric;
  c502: SqlNumeric;
  c503: SqlNumeric;
  c504: SqlNumeric;
  c5xx_other: SqlNumeric;
}

export interface TablePresenceRow {
  raw_present: boolean;
  aggregate_present: boolean;
}

export interface RawStatsRow {
  row_count: SqlNumeric;
  last_record_at: Date | null;
}

/**
 * Raw-table aggregates for `range=1h` (exact window start). Success is 2xx and error is >= 400,
 * mirroring `counter_success` / `counter_error`; the average is per request, so re-weighting it by
 * `requests` reproduces a request-weighted total, exactly like `SUM(total_latency)/SUM(hits)`.
 */
const RAW_ROLLUP_COLUMNS = Prisma.sql`
  COUNT(*)::bigint                                                            AS requests,
  COUNT(*) FILTER (WHERE responsecode >= 200 AND responsecode < 300)::bigint  AS success,
  COUNT(*) FILTER (WHERE responsecode >= 400)::bigint                         AS errors,
  AVG(latency_total)::numeric                                                 AS avg_latency_ms,
  AVG(latency_upstream)::numeric                                              AS avg_upstream_ms
`;

/** Heaviest first, bounded in SQL (C3). No `limit` ⇒ unbounded: the overview needs every API. */
function heaviestFirst(limit: number | undefined): Prisma.Sql {
  return limit === undefined
    ? Prisma.empty
    : Prisma.sql`ORDER BY requests DESC, dimension_value LIMIT ${limit}`;
}

/**
 * Per-API rollup. Feeds `/analytics/overview`, `/analytics/apis` and `/analytics/top-apis` — one
 * query shape, three endpoints. `1h` reads the raw table with the exact window start; longer ranges
 * read the hourly aggregate. Pass `limit` to keep only the busiest APIs.
 */
export function apiRollupQuery(window: AnalyticsWindow, tykApiIds: string[], limit?: number): Prisma.Sql {
  if (window.source === 'raw') {
    return Prisma.sql`
      SELECT apiid AS dimension_value, ${RAW_ROLLUP_COLUMNS}
      FROM public.tyk_analytics
      WHERE apiid = ANY(${tykApiIds}::text[])
        AND "timestamp" >= ${window.from}
      GROUP BY apiid
      ${heaviestFirst(limit)}
    `;
  }

  return Prisma.sql`
    SELECT dimension_value,
           SUM(counter_hits)::bigint    AS requests,
           SUM(counter_success)::bigint AS success,
           SUM(counter_error)::bigint   AS errors,
           SUM(counter_total_latency)::numeric / NULLIF(SUM(counter_hits), 0)          AS avg_latency_ms,
           SUM(counter_total_upstream_latency)::numeric / NULLIF(SUM(counter_hits), 0) AS avg_upstream_ms
    FROM public.tyk_aggregated
    WHERE dimension = 'apiid'
      AND dimension_value = ANY(${tykApiIds}::text[])
      AND "timestamp" >= ${window.fromEpochSeconds}
    GROUP BY dimension_value
    ${heaviestFirst(limit)}
  `;
}

/**
 * Per-key rollup. Scoped to the caller's own key hashes (`ApiKey.tykKeyId`), and unauthenticated
 * traffic (`00000000`) is excluded — it belongs to no key. Same window rule as `apiRollupQuery`.
 */
export function keyRollupQuery(window: AnalyticsWindow, keyHashes: string[], limit?: number): Prisma.Sql {
  if (window.source === 'raw') {
    return Prisma.sql`
      SELECT apikey AS dimension_value, ${RAW_ROLLUP_COLUMNS}
      FROM public.tyk_analytics
      WHERE apikey = ANY(${keyHashes}::text[])
        AND apikey <> ${UNAUTHENTICATED_KEY_HASH}
        AND "timestamp" >= ${window.from}
      GROUP BY apikey
      ${heaviestFirst(limit)}
    `;
  }

  return Prisma.sql`
    SELECT dimension_value,
           SUM(counter_hits)::bigint    AS requests,
           SUM(counter_success)::bigint AS success,
           SUM(counter_error)::bigint   AS errors,
           SUM(counter_total_latency)::numeric / NULLIF(SUM(counter_hits), 0)          AS avg_latency_ms,
           SUM(counter_total_upstream_latency)::numeric / NULLIF(SUM(counter_hits), 0) AS avg_upstream_ms
    FROM public.tyk_aggregated
    WHERE dimension = 'apikeys'
      AND dimension_value = ANY(${keyHashes}::text[])
      AND dimension_value <> ${UNAUTHENTICATED_KEY_HASH}
      AND "timestamp" >= ${window.fromEpochSeconds}
    GROUP BY dimension_value
    ${heaviestFirst(limit)}
  `;
}

/**
 * Keeps the NEWEST `MAX_TIME_SERIES_BUCKETS` buckets if the cap ever trips (C4): take the newest
 * first inside the subquery, then re-sort ascending for the chart. `inner` must end with `GROUP BY 1`
 * and select `bucket_epoch, requests, errors, avg_latency_ms`.
 */
function keepNewestBuckets(inner: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT bucket_epoch, requests, errors, avg_latency_ms
    FROM (
      ${inner}
      ORDER BY 1 DESC
      LIMIT ${MAX_TIME_SERIES_BUCKETS}
    ) newest
    ORDER BY bucket_epoch
  `;
}

/**
 * Time series. `1h` reads the raw table for minute buckets; longer ranges roll the hourly aggregate
 * up to hour or day buckets (spec §4.4, D8). Buckets are truncated in UTC and returned as a UTC
 * epoch (`bucket_epoch`), so they never depend on the DB session time zone.
 */
export function timeSeriesQuery(window: AnalyticsWindow, tykApiIds: string[]): Prisma.Sql {
  if (window.source === 'raw') {
    return keepNewestBuckets(Prisma.sql`
      SELECT EXTRACT(EPOCH FROM date_trunc(${window.bucket}::text, "timestamp" AT TIME ZONE 'UTC'))::bigint AS bucket_epoch,
             COUNT(*)::bigint                                         AS requests,
             COUNT(*) FILTER (WHERE responsecode >= 400)::bigint      AS errors,
             AVG(latency_total)::numeric                              AS avg_latency_ms
      FROM public.tyk_analytics
      WHERE apiid = ANY(${tykApiIds}::text[])
        AND "timestamp" >= ${window.from}
      GROUP BY 1
    `);
  }

  return keepNewestBuckets(Prisma.sql`
    SELECT EXTRACT(EPOCH FROM date_trunc(${window.bucket}::text, to_timestamp("timestamp") AT TIME ZONE 'UTC'))::bigint AS bucket_epoch,
           SUM(counter_hits)::bigint  AS requests,
           SUM(counter_error)::bigint AS errors,
           SUM(counter_total_latency)::numeric / NULLIF(SUM(counter_hits), 0) AS avg_latency_ms
    FROM public.tyk_aggregated
    WHERE dimension = 'apiid'
      AND dimension_value = ANY(${tykApiIds}::text[])
      AND "timestamp" >= ${window.fromEpochSeconds}
    GROUP BY 1
  `);
}

/**
 * Status-code breakdown, never from `dimension='errors'`: an `errors` row carries only the status
 * code and no `apiid`, so with one global `org_id` it cannot be tenant-scoped and reading it would
 * leak every tenant's error counts (spec §4.4). The aggregate path reads the `dimension='apiid'`
 * rows; 2xx comes from `counter_success`, because `code_2x`/`code_200` are always 0. `1h` counts
 * the raw rows instead, with the same columns and the same "other 4xx/5xx" buckets.
 */
export function statusCodeQuery(window: AnalyticsWindow, tykApiIds: string[]): Prisma.Sql {
  if (window.source === 'raw') {
    return Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE responsecode >= 200 AND responsecode < 300)::bigint AS c2xx,
             COUNT(*) FILTER (WHERE responsecode = 400)::bigint AS c400,
             COUNT(*) FILTER (WHERE responsecode = 401)::bigint AS c401,
             COUNT(*) FILTER (WHERE responsecode = 403)::bigint AS c403,
             COUNT(*) FILTER (WHERE responsecode = 404)::bigint AS c404,
             COUNT(*) FILTER (WHERE responsecode = 429)::bigint AS c429,
             COUNT(*) FILTER (WHERE responsecode >= 400 AND responsecode < 500
                                AND responsecode NOT IN (400, 401, 403, 404, 429))::bigint AS c4xx_other,
             COUNT(*) FILTER (WHERE responsecode = 500)::bigint AS c500,
             COUNT(*) FILTER (WHERE responsecode = 502)::bigint AS c502,
             COUNT(*) FILTER (WHERE responsecode = 503)::bigint AS c503,
             COUNT(*) FILTER (WHERE responsecode = 504)::bigint AS c504,
             COUNT(*) FILTER (WHERE responsecode >= 500 AND responsecode < 600
                                AND responsecode NOT IN (500, 502, 503, 504))::bigint AS c5xx_other
      FROM public.tyk_analytics
      WHERE apiid = ANY(${tykApiIds}::text[])
        AND "timestamp" >= ${window.from}
    `;
  }

  return Prisma.sql`
    SELECT SUM(counter_success)::bigint AS c2xx,
           SUM(code_400)::bigint AS c400, SUM(code_401)::bigint AS c401, SUM(code_403)::bigint AS c403,
           SUM(code_404)::bigint AS c404, SUM(code_429)::bigint AS c429, SUM(code_4x)::bigint AS c4xx_other,
           SUM(code_500)::bigint AS c500, SUM(code_502)::bigint AS c502, SUM(code_503)::bigint AS c503,
           SUM(code_504)::bigint AS c504, SUM(code_5x)::bigint AS c5xx_other
    FROM public.tyk_aggregated
    WHERE dimension = 'apiid'
      AND dimension_value = ANY(${tykApiIds}::text[])
      AND "timestamp" >= ${window.fromEpochSeconds}
  `;
}

/** Both pump tables may be absent until the pump's first purge — presence is a first-class answer. */
export function tablePresenceQuery(): Prisma.Sql {
  return Prisma.sql`
    SELECT to_regclass('public.tyk_analytics')  IS NOT NULL AS raw_present,
           to_regclass('public.tyk_aggregated') IS NOT NULL AS aggregate_present
  `;
}

/** Tenant-scoped freshness of the raw table, for `/analytics/health`. */
export function rawStatsQuery(tykApiIds: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS row_count,
           MAX("timestamp") AS last_record_at
    FROM public.tyk_analytics
    WHERE apiid = ANY(${tykApiIds}::text[])
  `;
}

/** Retention (D10): the raw table's `timestamp` is a timestamptz. */
export function retentionRawQuery(days: number): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM public.tyk_analytics
     WHERE "timestamp" < now() - make_interval(days => ${days}::int)
  `;
}

/**
 * Retention (D10): `tyk_aggregated."timestamp"` is a bigint epoch. The cutoff is computed into an
 * epoch and compared against the bare column — wrapping the column in `to_timestamp()` would make
 * `tyk_aggregated_idx_dimension` unusable.
 */
export function retentionAggregateQuery(days: number): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM public.tyk_aggregated
     WHERE "timestamp" < EXTRACT(EPOCH FROM now() - make_interval(days => ${days}::int))::bigint
  `;
}

/**
 * Indexes we own (D9). `tyk_analytics` ships with **zero** indexes: the `sql` pump only creates its
 * own inside the `table_sharding: true` code path, and we run with sharding off. Created on module
 * init rather than in a Prisma migration, because the pump creates the tables at *its* startup,
 * which can be after `migrate deploy`, and an applied migration never re-runs.
 *
 * Constant string — the one permitted `$queryRawUnsafe` (a DO block cannot be parameterised).
 */
export const ANALYTICS_INDEX_DDL = `
DO $$ BEGIN
  IF to_regclass('public.tyk_analytics') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS og_tyk_analytics_apiid_ts  ON public.tyk_analytics (apiid, "timestamp" DESC);
    CREATE INDEX IF NOT EXISTS og_tyk_analytics_ts        ON public.tyk_analytics ("timestamp" DESC);
    CREATE INDEX IF NOT EXISTS og_tyk_analytics_apikey_ts ON public.tyk_analytics (apikey, "timestamp" DESC);
  END IF;
END $$;
`;
