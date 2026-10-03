import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import {
  ANALYTICS_INDEX_DDL,
  analyticsRedactionDdl,
  analyticsWindow,
  apiRollupQuery,
  errorRatePercent,
  keyRollupQuery,
  MAX_REDACTED_DUMP_CHARS,
  MAX_TIME_SERIES_BUCKETS,
  rawStatsQuery,
  REDACTION_TRIGGER,
  retentionAggregateQuery,
  retentionRawQuery,
  statusCodeQuery,
  tablePresenceQuery,
  timeSeriesQuery,
  toNumber,
  TRUNCATED_DUMP_MARKER,
  UNAUTHENTICATED_KEY_HASH,
} from './pump-query.builder';

const NOW = new Date('2026-09-19T14:37:30.000Z');
const TENANT_IDS = ['probe-1', 'probe-2'];
const RAW_WINDOW = analyticsWindow('1h', NOW);
const AGG_WINDOW = analyticsWindow('24h', NOW);

/** Collapse whitespace so assertions can match the SQL as written in the spec. */
function flat(sql: { text: string }): string {
  return sql.text.replace(/\s+/g, ' ').trim();
}

describe('analyticsWindow', () => {
  it.each([
    ['24h' as const, '2026-09-18T14:37:30.000Z', '2026-09-18T14:00:00.000Z', 'hour'],
    ['7d' as const, '2026-09-12T14:37:30.000Z', '2026-09-12T14:00:00.000Z', 'hour'],
    ['30d' as const, '2026-08-20T14:37:30.000Z', '2026-08-20T14:00:00.000Z', 'day'],
  ])('reads the hourly aggregate for %s, with its start floored to the hour bucket', (range, from, floored, bucket) => {
    const window = analyticsWindow(range, NOW);

    expect(window.from.toISOString()).toBe(from);
    // the aggregate table's bigint timestamp is the START of an hourly bucket, so the lower bound
    // must be floored to the hour or the bucket covering `from` is dropped
    expect(new Date(window.fromEpochSeconds * 1000).toISOString()).toBe(floored);
    expect(window.bucket).toBe(bucket);
    expect(window.source).toBe('aggregate');
  });

  it('reads the raw table for 1h, with minute buckets and the exact (unfloored) window start', () => {
    expect(RAW_WINDOW.source).toBe('raw');
    expect(RAW_WINDOW.bucket).toBe('minute');
    expect(RAW_WINDOW.from.toISOString()).toBe('2026-09-19T13:37:30.000Z');
  });
});

describe('numeric helpers', () => {
  it('coerces Postgres bigint/numeric/string/null shapes to numbers', () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber(7n)).toBe(7);
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(new Prisma.Decimal('3.25'))).toBe(3.25);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('not-a-number')).toBe(0);
  });

  it('expresses the error rate as a percentage 0-100 with two decimals', () => {
    expect(errorRatePercent(3, 8)).toBe(37.5);
    expect(errorRatePercent(1, 3)).toBe(33.33);
    expect(errorRatePercent(0, 0)).toBe(0);
    expect(errorRatePercent(8, 8)).toBe(100);
  });
});

describe('apiRollupQuery', () => {
  const sql = apiRollupQuery(AGG_WINDOW, TENANT_IDS);

  it('binds the tenant apiid array instead of interpolating it', () => {
    expect(sql.values).toEqual([TENANT_IDS, AGG_WINDOW.fromEpochSeconds]);
    expect(flat(sql)).toContain('dimension_value = ANY($1::text[])');
    expect(sql.text).not.toContain('probe-1');
  });

  it('scopes to dimension=apiid and never to errors or the org-wide total', () => {
    expect(flat(sql)).toContain("dimension = 'apiid'");
    expect(sql.text).not.toContain("dimension = 'errors'");
    expect(sql.text).not.toContain("dimension = ''");
  });

  it('derives totals from counter_* and never from code_2x/code_200', () => {
    expect(sql.text).toContain('SUM(counter_hits)');
    expect(sql.text).toContain('SUM(counter_success)');
    expect(sql.text).toContain('SUM(counter_error)');
    expect(sql.text).not.toContain('code_2x');
    expect(sql.text).not.toContain('code_200');
  });

  it('computes the weighted latency average, not an average of averages', () => {
    expect(flat(sql)).toContain('SUM(counter_total_latency)::numeric / NULLIF(SUM(counter_hits), 0)');
    expect(flat(sql)).toContain(
      'SUM(counter_total_upstream_latency)::numeric / NULLIF(SUM(counter_hits), 0)',
    );
    expect(sql.text).not.toContain('AVG(counter_latency)');
  });

  it('is unbounded without a limit (the overview needs every API) and bound-limited with one', () => {
    expect(flat(sql)).not.toContain('LIMIT');

    const limited = apiRollupQuery(AGG_WINDOW, TENANT_IDS, 100);
    expect(flat(limited)).toMatch(/GROUP BY dimension_value ORDER BY requests DESC, dimension_value LIMIT \$3$/);
    expect(limited.values).toEqual([TENANT_IDS, AGG_WINDOW.fromEpochSeconds, 100]);
  });

  describe('range 1h (raw table, exact window start)', () => {
    const raw = apiRollupQuery(RAW_WINDOW, TENANT_IDS, 50);

    it('reads tyk_analytics with the exact from, never the hour-floored epoch', () => {
      expect(flat(raw)).toContain('FROM public.tyk_analytics');
      expect(flat(raw)).toContain('apiid = ANY($1::text[])');
      expect(flat(raw)).toContain('"timestamp" >= $2');
      expect(raw.text).not.toContain('tyk_aggregated');
      expect(raw.values).toEqual([TENANT_IDS, new Date('2026-09-19T13:37:30.000Z'), 50]);
      expect(raw.values).not.toContain(RAW_WINDOW.fromEpochSeconds);
      expect(raw.text).not.toContain('probe-1');
    });

    it('counts errors as responsecode >= 400 and success as 2xx, with per-request latency averages', () => {
      expect(flat(raw)).toContain('COUNT(*) FILTER (WHERE responsecode >= 400)::bigint AS errors');
      expect(flat(raw)).toContain(
        'COUNT(*) FILTER (WHERE responsecode >= 200 AND responsecode < 300)::bigint AS success',
      );
      expect(flat(raw)).toContain('COUNT(*)::bigint AS requests');
      expect(flat(raw)).toContain('AVG(latency_total)::numeric AS avg_latency_ms');
      expect(flat(raw)).toContain('AVG(latency_upstream)::numeric AS avg_upstream_ms');
      expect(flat(raw)).toMatch(/GROUP BY apiid ORDER BY requests DESC, dimension_value LIMIT \$3$/);
    });

    it('is unbounded without a limit', () => {
      const overview = apiRollupQuery(RAW_WINDOW, TENANT_IDS);
      expect(flat(overview)).not.toContain('LIMIT');
      expect(overview.values).toEqual([TENANT_IDS, new Date('2026-09-19T13:37:30.000Z')]);
    });
  });
});

describe('keyRollupQuery', () => {
  const sql = keyRollupQuery(AGG_WINDOW, ['hash-a', 'hash-b']);

  it('binds the tenant key hashes and excludes unauthenticated traffic', () => {
    expect(sql.values).toEqual([['hash-a', 'hash-b'], UNAUTHENTICATED_KEY_HASH, AGG_WINDOW.fromEpochSeconds]);
    expect(flat(sql)).toContain("dimension = 'apikeys'");
    expect(flat(sql)).toContain('dimension_value = ANY($1::text[])');
    expect(flat(sql)).toContain('dimension_value <> $2');
  });

  it('uses counter_* totals and the weighted latency average', () => {
    expect(sql.text).toContain('SUM(counter_hits)');
    expect(flat(sql)).toContain('SUM(counter_total_latency)::numeric / NULLIF(SUM(counter_hits), 0)');
    expect(sql.text).not.toContain('code_2x');
  });

  it('keeps only the busiest keys when limited, ordered by hits', () => {
    const limited = keyRollupQuery(AGG_WINDOW, ['hash-a'], 100);
    expect(flat(limited)).toMatch(/ORDER BY requests DESC, dimension_value LIMIT \$4$/);
    expect(limited.values).toEqual([['hash-a'], UNAUTHENTICATED_KEY_HASH, AGG_WINDOW.fromEpochSeconds, 100]);
  });

  it('range 1h reads the raw table by apikey with the exact from and still skips unauthenticated traffic', () => {
    const raw = keyRollupQuery(RAW_WINDOW, ['hash-a'], 50);

    expect(flat(raw)).toContain('FROM public.tyk_analytics');
    expect(flat(raw)).toContain('apikey = ANY($1::text[])');
    expect(flat(raw)).toContain('apikey <> $2');
    expect(flat(raw)).toContain('"timestamp" >= $3');
    expect(flat(raw)).toContain('COUNT(*) FILTER (WHERE responsecode >= 400)::bigint AS errors');
    expect(flat(raw)).toMatch(/GROUP BY apikey ORDER BY requests DESC, dimension_value LIMIT \$4$/);
    expect(raw.values).toEqual([['hash-a'], UNAUTHENTICATED_KEY_HASH, new Date('2026-09-19T13:37:30.000Z'), 50]);
  });
});

describe('timeSeriesQuery', () => {
  it('reads the raw table with UTC minute buckets for 1h, bound to the tenant apiids', () => {
    const sql = timeSeriesQuery(RAW_WINDOW, TENANT_IDS);

    expect(flat(sql)).toContain('FROM public.tyk_analytics');
    expect(flat(sql)).toContain(
      `EXTRACT(EPOCH FROM date_trunc($1::text, "timestamp" AT TIME ZONE 'UTC'))::bigint AS bucket_epoch`,
    );
    expect(flat(sql)).toContain('apiid = ANY($2::text[])');
    expect(sql.values).toEqual(['minute', TENANT_IDS, new Date('2026-09-19T13:37:30.000Z'), MAX_TIME_SERIES_BUCKETS]);
  });

  it.each([
    ['24h' as const, 'hour'],
    ['7d' as const, 'hour'],
    ['30d' as const, 'day'],
  ])('rolls the aggregate table up to UTC %s buckets for %s', (range, bucket) => {
    const window = analyticsWindow(range, NOW);
    const sql = timeSeriesQuery(window, TENANT_IDS);

    expect(flat(sql)).toContain('FROM public.tyk_aggregated');
    expect(flat(sql)).toContain(
      `EXTRACT(EPOCH FROM date_trunc($1::text, to_timestamp("timestamp") AT TIME ZONE 'UTC'))::bigint AS bucket_epoch`,
    );
    expect(flat(sql)).toContain("dimension = 'apiid'");
    expect(sql.values).toEqual([bucket, TENANT_IDS, window.fromEpochSeconds, MAX_TIME_SERIES_BUCKETS]);
  });

  it.each([['1h' as const], ['24h' as const], ['30d' as const]])(
    'never truncates in the DB session time zone (%s)',
    (range) => {
      const text = flat(timeSeriesQuery(analyticsWindow(range, NOW), TENANT_IDS));

      // every date_trunc input is forced to UTC before truncating; no bare timestamptz reaches it
      expect(text.match(/date_trunc\(/g)).toHaveLength(1);
      expect(text).toMatch(/date_trunc\(\$1::text, [^,]*? AT TIME ZONE 'UTC'\)\)/);
    },
  );

  it.each([['1h' as const], ['30d' as const]])(
    'keeps the NEWEST buckets when the cap trips, then re-sorts ascending (%s)',
    (range) => {
      const sql = timeSeriesQuery(analyticsWindow(range, NOW), TENANT_IDS);

      expect(MAX_TIME_SERIES_BUCKETS).toBe(750);
      // inner: newest first + LIMIT; outer: ascending for the chart
      expect(flat(sql)).toMatch(/GROUP BY 1 ORDER BY 1 DESC LIMIT \$4 \) newest ORDER BY bucket_epoch$/);
      expect(flat(sql)).not.toMatch(/ORDER BY 1 ASC|ORDER BY 1 LIMIT/);
    },
  );
});

describe('statusCodeQuery', () => {
  const sql = statusCodeQuery(AGG_WINDOW, TENANT_IDS);

  it('is tenant-scoped through dimension=apiid and a bound apiid array', () => {
    expect(flat(sql)).toContain("dimension = 'apiid'");
    expect(flat(sql)).toContain('dimension_value = ANY($1::text[])');
    expect(sql.values).toEqual([TENANT_IDS, AGG_WINDOW.fromEpochSeconds]);
    expect(sql.text).not.toContain('probe-1');
  });

  it("never reads dimension='errors', which carries no apiid and cannot be tenant-scoped", () => {
    expect(sql.text).not.toContain('errors');
  });

  it('takes 2xx from counter_success and error codes from the code_* columns', () => {
    expect(sql.text).toContain('SUM(counter_success)::bigint AS c2xx');
    expect(sql.text).toContain('SUM(code_401)');
    expect(sql.text).toContain('SUM(code_500)');
    expect(sql.text).not.toContain('code_2x');
    expect(sql.text).not.toContain('code_200');
  });

  it('range 1h counts the raw rows tenant-scoped with the exact from, same columns as the aggregate path', () => {
    const raw = statusCodeQuery(RAW_WINDOW, TENANT_IDS);

    expect(flat(raw)).toContain('FROM public.tyk_analytics');
    expect(flat(raw)).toContain('apiid = ANY($1::text[])');
    expect(raw.values).toEqual([TENANT_IDS, new Date('2026-09-19T13:37:30.000Z')]);
    expect(raw.text).not.toContain('tyk_aggregated');
    expect(raw.text).not.toContain('dimension');
    for (const column of ['c2xx', 'c400', 'c401', 'c403', 'c404', 'c429', 'c4xx_other', 'c500', 'c502', 'c503', 'c504', 'c5xx_other']) {
      expect(flat(raw)).toContain(`AS ${column}`);
    }
    expect(flat(raw)).toContain('responsecode NOT IN (400, 401, 403, 404, 429)');
    expect(flat(raw)).toContain('responsecode NOT IN (500, 502, 503, 504)');
  });
});

describe('raw-path error predicate', () => {
  it.each([
    ['time series', timeSeriesQuery(RAW_WINDOW, TENANT_IDS)],
    ['api rollup', apiRollupQuery(RAW_WINDOW, TENANT_IDS)],
    ['key rollup', keyRollupQuery(RAW_WINDOW, ['hash-a'])],
  ])('counts an error as responsecode >= 400 in the %s', (_label, sql) => {
    expect(flat(sql)).toContain('COUNT(*) FILTER (WHERE responsecode >= 400)::bigint');
    // a literal comparison in the SQL text: nothing user-supplied can reach the predicate
    expect(sql.values.every((value) => value !== 400)).toBe(true);
  });
});

describe('presence and health queries', () => {
  it('asks to_regclass for both pump tables', () => {
    const sql = tablePresenceQuery();

    expect(flat(sql)).toContain("to_regclass('public.tyk_analytics') IS NOT NULL AS raw_present");
    expect(flat(sql)).toContain("to_regclass('public.tyk_aggregated') IS NOT NULL AS aggregate_present");
    expect(sql.values).toEqual([]);
  });

  it('scopes the raw-table stats to the tenant apiids', () => {
    const sql = rawStatsQuery(TENANT_IDS);

    expect(flat(sql)).toContain('apiid = ANY($1::text[])');
    expect(sql.values).toEqual([TENANT_IDS]);
  });
});

describe('retention queries', () => {
  it('trims the raw table with make_interval on its timestamptz column', () => {
    const sql = retentionRawQuery(30);

    expect(flat(sql)).toBe(
      'DELETE FROM public.tyk_analytics WHERE "timestamp" < now() - make_interval(days => $1::int)',
    );
    expect(sql.values).toEqual([30]);
  });

  it('compares the aggregate bigint epoch directly so its index stays usable', () => {
    const sql = retentionAggregateQuery(365);

    expect(flat(sql)).toBe(
      'DELETE FROM public.tyk_aggregated WHERE "timestamp" < EXTRACT(EPOCH FROM now() - make_interval(days => $1::int))::bigint',
    );
    expect(sql.values).toEqual([365]);
    // wrapping the column would disable tyk_aggregated_idx_dimension
    expect(sql.text).not.toContain('to_timestamp("timestamp")');
  });
});

describe('ANALYTICS_INDEX_DDL', () => {
  const indexes = [
    ...ANALYTICS_INDEX_DDL.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON public\.tyk_analytics \(([^)]*)\)/g),
  ].map(([, name, columns]) => ({ name, columns: columns.split(',').map((column) => column.trim()) }));

  it('is a guarded DO block whose every CREATE INDEX is idempotent and namespaced away from the pump', () => {
    expect(ANALYTICS_INDEX_DDL.match(/CREATE INDEX/g)).toHaveLength(indexes.length);
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every(({ name }) => name.startsWith('og_'))).toBe(true);
    expect(ANALYTICS_INDEX_DDL.indexOf("to_regclass('public.tyk_analytics') IS NOT NULL")).toBeGreaterThan(-1);
    expect(ANALYTICS_INDEX_DDL.indexOf("to_regclass('public.tyk_analytics')")).toBeLessThan(
      ANALYTICS_INDEX_DDL.indexOf('CREATE INDEX'),
    );
  });

  it.each([
    ['api rollup', apiRollupQuery(RAW_WINDOW, TENANT_IDS)],
    ['key rollup', keyRollupQuery(RAW_WINDOW, ['hash-a'])],
    ['time series', timeSeriesQuery(RAW_WINDOW, TENANT_IDS)],
    ['status codes', statusCodeQuery(RAW_WINDOW, TENANT_IDS)],
    ['raw stats', rawStatsQuery(TENANT_IDS)],
  ])('backs the %s filter with an index led by its tenant column then "timestamp"', (_label, sql) => {
    const [, leading] = /WHERE (\w+) = ANY/.exec(flat(sql)) ?? [];

    expect(leading).toBeDefined();
    expect(indexes.some(({ columns }) => columns[0] === leading && columns[1].startsWith('"timestamp"'))).toBe(true);
  });
});


describe('ANALYTICS_INDEX_DDL: what the search indexer reads', () => {
  it('has a partial index on the timestamp of captured rows, with the predicate the indexer filters on', () => {
    expect(ANALYTICS_INDEX_DDL).toMatch(
      /CREATE INDEX IF NOT EXISTS og_tyk_analytics_captured_ts ON public\.tyk_analytics \("timestamp"\)\s+WHERE rawrequest <> '' OR rawresponse <> ''/,
    );
  });
});

describe('analyticsRedactionDdl: the install, as text', () => {
  const ddl = analyticsRedactionDdl(['password', 'token']);

  it('issues trigger DDL only when the trigger is missing, disabled or not the right kind, after bounding the lock wait', () => {
    expect(ddl).toContain('trigger_needs_install := NOT EXISTS');
    expect(ddl).toContain("tgenabled IN ('O', 'A')");
    expect(ddl).toContain('tgtype = 7'); // row + before + insert
    expect(ddl).toContain("tgfoid = 'public.og_redact_tyk_analytics'::regproc");
    const guard = ddl.indexOf('IF trigger_needs_install THEN');
    const lock = ddl.indexOf("set_config('lock_timeout', '5s', true)");
    const drop = ddl.indexOf('DROP TRIGGER IF EXISTS og_redact_tyk_analytics_trg');
    const create = ddl.indexOf('CREATE TRIGGER og_redact_tyk_analytics_trg');
    expect(guard).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(guard);
    expect(drop).toBeGreaterThan(lock);
    expect(create).toBeGreaterThan(drop);
    // Nothing that takes the table lock sits outside the guard.
    expect(ddl.slice(0, guard)).not.toContain('DROP TRIGGER');
    expect(ddl.slice(0, guard)).not.toContain('CREATE TRIGGER');
  });

  it('rewrites only the rows the function changes, computing it once per row', () => {
    const update = ddl.slice(ddl.indexOf('UPDATE public.tyk_analytics t'));
    expect(update).toContain('t.rawrequest IS DISTINCT FROM r.rq OR t.rawresponse IS DISTINCT FROM r.rs');
    expect(update.match(/og_redact_http_dump\(/g)).toHaveLength(2); // once per column, in the subquery
    expect(update).not.toMatch(/SET rawrequest = og_redact_http_dump/);
  });

  it('takes the truncation marker off a dump it already cut before counting, so a second pass is a no-op', () => {
    const body = ddl.slice(ddl.indexOf('CREATE OR REPLACE FUNCTION og_redact_http_dump'), ddl.indexOf('CREATE OR REPLACE FUNCTION og_redact_tyk_analytics'));
    const strip = body.indexOf("truncated := right(plain, length(marker) + 1) = E'\\n' || marker");
    const count = body.indexOf(`truncated := truncated OR length(plain) > ${String(MAX_REDACTED_DUMP_CHARS)}`);
    const cut = body.indexOf(`plain := left(plain, ${String(MAX_REDACTED_DUMP_CHARS)})`);
    expect(strip).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(strip);
    expect(cut).toBeGreaterThan(count);
    expect(body).toContain(`marker text := '${TRUNCATED_DUMP_MARKER}'`);
    expect(body).toContain(`plain := plain || E'\\n${TRUNCATED_DUMP_MARKER}'`);
  });

  it('still creates the trigger under the name the presence check looks for', () => {
    expect(ddl).toContain(`CREATE TRIGGER ${REDACTION_TRIGGER}`);
  });
});
