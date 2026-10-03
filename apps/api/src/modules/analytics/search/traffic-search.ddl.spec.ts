import {
  TRAFFIC_SEARCH_DDL,
  addDays,
  dropPartitionDdl,
  expiredPartitions,
  partitionDay,
  partitionDdl,
  partitionName,
  utcDay,
} from './traffic-search.ddl';

describe('traffic search DDL', () => {
  it('builds the full-text index on the stored column the query reads, and drops the expression index it replaces', () => {
    expect(TRAFFIC_SEARCH_DDL).toMatch(/CREATE INDEX IF NOT EXISTS og_traffic_search_fts_col\s+ON public\.og_traffic_search USING gin \(fts\)/);
    expect(TRAFFIC_SEARCH_DDL).toContain('DROP INDEX IF EXISTS public.og_traffic_search_fts;');
    expect(TRAFFIC_SEARCH_DDL).not.toContain('to_tsvector');
  });

  it('adds the columns an older table lacks in place, each guarded, after the table it extends', () => {
    for (const column of ['unredactable boolean NOT NULL DEFAULT false', 'fts tsvector']) {
      expect(TRAFFIC_SEARCH_DDL).toContain(`ALTER TABLE public.og_traffic_search ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const column of ['indexed_from timestamptz', 'generation bigint NOT NULL DEFAULT 0', 'redaction_tag text', "auth_headers jsonb NOT NULL DEFAULT '{}'::jsonb"]) {
      expect(TRAFFIC_SEARCH_DDL).toContain(`ALTER TABLE public.og_traffic_search_state ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(TRAFFIC_SEARCH_DDL.indexOf('ADD COLUMN IF NOT EXISTS fts')).toBeGreaterThan(TRAFFIC_SEARCH_DDL.indexOf('CREATE TABLE IF NOT EXISTS public.og_traffic_search ('));
  });

  it('creates the lean index set and nothing heavier', () => {
    for (const name of ['dedupe', 'apiid_ts', 'apiid_method_ts', 'req_headers', 'res_headers', 'fts_col']) {
      expect(TRAFFIC_SEARCH_DDL).toContain(`og_traffic_search_${name}`);
    }
    expect(TRAFFIC_SEARCH_DDL).not.toMatch(/gin_trgm_ops|res_json|WHERE status/);
  });

  it('is one DO block of idempotent statements, so a prepared statement can hold it', () => {
    expect(TRAFFIC_SEARCH_DDL.trim().startsWith('DO $$ BEGIN')).toBe(true);
    const statements = TRAFFIC_SEARCH_DDL.match(/CREATE (?:UNIQUE )?(?:INDEX|TABLE|SEQUENCE)[^;]*/g) ?? [];
    expect(statements.length).toBeGreaterThan(8);
    for (const s of statements) expect(s).toContain('IF NOT EXISTS');
  });

  it('keys the dedupe index on ts as well, because a unique index on a partitioned table must include the partition key', () => {
    expect(TRAFFIC_SEARCH_DDL).toMatch(/UNIQUE INDEX IF NOT EXISTS og_traffic_search_dedupe\s+ON public\.og_traffic_search \(ts, dedupe_key\)/);
  });
});

describe('partitions', () => {
  const day = new Date('2026-09-29T17:45:10.123Z');

  it('names a partition by its UTC day, whatever the time of day', () => {
    expect(partitionName(day)).toBe('og_traffic_search_20260929');
    expect(partitionName(new Date('2026-01-05T00:00:00.000Z'))).toBe('og_traffic_search_20260105');
    expect(partitionName(new Date('2026-12-31T23:59:59.999Z'))).toBe('og_traffic_search_20261231');
  });

  it('round-trips a name, and rejects anything that is not one of ours', () => {
    expect(partitionDay('og_traffic_search_20260929')?.toISOString()).toBe('2026-09-29T00:00:00.000Z');
    for (const bad of ['og_traffic_search', 'og_traffic_search_state', 'og_traffic_search_2026929', 'og_traffic_search_20261340', 'tyk_analytics', 'og_traffic_search_20260929; DROP TABLE x']) {
      expect(partitionDay(bad)).toBeNull();
    }
  });

  it('bounds a partition to exactly one UTC day', () => {
    expect(partitionDdl(day)).toBe(
      "CREATE TABLE IF NOT EXISTS public.og_traffic_search_20260929 PARTITION OF public.og_traffic_search FOR VALUES FROM ('2026-09-29 00:00:00+00') TO ('2026-09-30 00:00:00+00')",
    );
  });

  it('rolls over month and year ends', () => {
    expect(partitionDdl(new Date('2026-12-31T10:00:00Z'))).toContain("TO ('2027-01-01 00:00:00+00')");
    expect(partitionDdl(new Date('2028-02-28T10:00:00Z'))).toContain("TO ('2028-02-29 00:00:00+00')");
  });

  it('utcDay and addDays work on UTC, not the machine time zone', () => {
    expect(utcDay(new Date('2026-09-29T23:59:59.999Z')).toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(addDays(utcDay(day), 2).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('retention', () => {
  const now = new Date('2026-09-29T03:00:00.000Z');
  const names = ['20260828', '20260829', '20260830', '20260928', '20260929', '20261001'].map((d) => `og_traffic_search_${d}`);

  it('drops only whole days older than the window: 30 days keeps the 30th day back', () => {
    // cutoff is 2026-08-30 00:00Z: the 29th is expired, the 30th is the oldest day kept.
    expect(expiredPartitions(names, 30, now)).toEqual(['og_traffic_search_20260828', 'og_traffic_search_20260829']);
  });

  it('never proposes the state table, the parent, or an unrelated table', () => {
    expect(expiredPartitions(['og_traffic_search', 'og_traffic_search_state', 'tyk_analytics', 'pg_toast_1'], 1, now)).toEqual([]);
  });

  it('refuses to build a DROP for a name that is not a partition', () => {
    expect(() => dropPartitionDdl('tyk_analytics')).toThrow(/Not a traffic-search partition/);
    expect(() => dropPartitionDdl('og_traffic_search_20260829; DROP TABLE tyk_analytics')).toThrow();
    expect(dropPartitionDdl('og_traffic_search_20260829')).toBe('DROP TABLE IF EXISTS public.og_traffic_search_20260829');
  });
});
