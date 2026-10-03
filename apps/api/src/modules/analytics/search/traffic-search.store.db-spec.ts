import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';
import { addDays, partitionName, utcDay } from './traffic-search.ddl';
import { trafficSearchQuery } from './traffic-search.query.builder';
import { TrafficSearchStoreService } from './traffic-search.store.service';
import { validateSearchRequest } from './traffic-search.validate';

/**
 * The search table's lifecycle against a REAL Postgres: idempotent DDL, one partition per day ahead of
 * the clock, retention by partition drop, and a 24h word search that prunes old partitions and is
 * answered by the full-text GIN index. Not part of `jest` (the name does not match `.spec.ts`): it
 * needs a THROWAWAY database — never the stack's.
 *
 *   docker run -d --rm --name og-probe-search-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55451:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55451/t?schema=public'
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'traffic-search\.store\.db-spec\.ts$')
 *   docker rm -f og-probe-search-pg
 */

jest.setTimeout(60_000);

const NOW = new Date('2026-09-29T12:00:00.000Z');
const TODAY = utcDay(NOW);

describe('traffic search store on a real Postgres', () => {
  const config = { get: (_key: string) => undefined } as unknown as ConfigService;
  const store = new TrafficSearchStoreService(prisma, config);
  let warn: jest.SpyInstance;

  const tables = async (): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = to_regclass('public.og_traffic_search') ORDER BY 1`;
    return rows.map((r) => r.name);
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
    warn = jest.spyOn(Logger.prototype, 'warn');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$disconnect();
  });

  it('creates the table, its indexes and three partitions, and a second run changes nothing', async () => {
    await store.maintain(NOW);
    const before = await tables();
    await store.maintain(NOW);
    await store.maintain(NOW);

    expect(warn).not.toHaveBeenCalled();
    expect(await tables()).toEqual(before);
    expect(before).toEqual([0, 1, 2].map((d) => partitionName(addDays(TODAY, d))));

    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'og_traffic_search' ORDER BY 1`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      'og_traffic_search_apiid_method_ts',
      'og_traffic_search_apiid_ts',
      'og_traffic_search_dedupe',
      'og_traffic_search_fts_col',
      'og_traffic_search_req_headers',
      'og_traffic_search_res_headers',
    ]);
    const state = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM public.og_traffic_search_state`;
    expect(Number(state[0]?.n)).toBe(0);
  });

  it('three processes running the same DDL at once do not fail: the advisory lock serialises them', async () => {
    // Without the lock a concurrent CREATE TABLE IF NOT EXISTS failed (42P07 / 23505) in 1 of 3 rounds on PG 16.
    for (let round = 0; round < 4; round += 1) {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
      await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
      warn.mockClear();
      const results = await Promise.all([store.maintain(NOW), store.maintain(NOW), store.maintain(NOW)]);
      expect(results).toEqual([true, true, true]);
      expect(warn).not.toHaveBeenCalled();
      expect(await tables()).toHaveLength(3);
    }
  });

  it('upgrades a table built before the stored vector, the stored flag and the state columns existed, in place', async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
    // The table as the first version created it: no `fts`, no `unredactable`, the expression index, a two-column state.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE public.og_traffic_search (
        id bigserial NOT NULL, ts timestamptz NOT NULL, apiid text NOT NULL, method text NOT NULL DEFAULT '', path text NOT NULL DEFAULT '',
        status integer NOT NULL DEFAULT 0, latency_ms integer NOT NULL DEFAULT 0, key_alias text NOT NULL DEFAULT '', ip text NOT NULL DEFAULT '',
        req_headers jsonb NOT NULL DEFAULT '{}'::jsonb, res_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
        req_body text NOT NULL DEFAULT '', res_body text NOT NULL DEFAULT '',
        req_truncated boolean NOT NULL DEFAULT false, res_truncated boolean NOT NULL DEFAULT false, dedupe_key text NOT NULL
      ) PARTITION BY RANGE (ts)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE public.og_traffic_search_20260929 PARTITION OF public.og_traffic_search FOR VALUES FROM ('2026-09-29 00:00:00+00') TO ('2026-09-30 00:00:00+00')`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX og_traffic_search_dedupe ON public.og_traffic_search (ts, dedupe_key)`);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX og_traffic_search_fts ON public.og_traffic_search USING gin ((to_tsvector('simple', coalesce(req_body, '') || ' ' || coalesce(res_body, ''))))`,
    );
    await prisma.$executeRawUnsafe(`CREATE TABLE public.og_traffic_search_state (id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), scanned_until timestamptz NOT NULL)`);
    await prisma.$executeRawUnsafe(`INSERT INTO public.og_traffic_search_state (id, scanned_until) VALUES (1, '2026-09-29T11:00:00Z')`);
    await prisma.$executeRawUnsafe(`INSERT INTO public.og_traffic_search (ts, apiid, dedupe_key, res_body) VALUES ('2026-09-29T10:00:00Z', 'a1', 'old', 'an old row')`);

    expect(await store.maintain(NOW)).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('fts', 'unredactable', 'indexed_from', 'generation', 'redaction_tag', 'auth_headers') ORDER BY 1, 2`;
    // The parent and every partition (the one that existed, and the two days ahead the upkeep added) carry both columns.
    const partitions = [0, 1, 2].map((d) => partitionName(addDays(TODAY, d)));
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'og_traffic_search.fts',
      'og_traffic_search.unredactable',
      ...partitions.flatMap((name) => [`${name}.fts`, `${name}.unredactable`]),
      'og_traffic_search_state.auth_headers',
      'og_traffic_search_state.generation',
      'og_traffic_search_state.indexed_from',
      'og_traffic_search_state.redaction_tag',
    ]);
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'og_traffic_search' ORDER BY 1`;
    expect(indexes.map((i) => i.indexname)).toContain('og_traffic_search_fts_col');
    expect(indexes.map((i) => i.indexname)).not.toContain('og_traffic_search_fts'); // the expression index is gone
    // What was there survives, with no vector yet (the indexer rebuilds it): it matches nothing instead of failing.
    const old = await prisma.$queryRaw<{ n: bigint; fts: number }[]>`SELECT count(*)::bigint AS n, count(fts)::int AS fts FROM public.og_traffic_search`;
    expect(Number(old[0]?.n)).toBe(1);
    expect(old[0]?.fts).toBe(0);
    const state = await prisma.$queryRaw<{ generation: bigint; indexed_from: Date | null; redaction_tag: string | null }[]>`
      SELECT generation, indexed_from, redaction_tag FROM public.og_traffic_search_state`;
    expect(state).toEqual([{ generation: 0n, indexed_from: null, redaction_tag: null }]);
    // Running it again changes nothing.
    expect(await store.maintain(NOW)).toBe(true);
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
    await store.maintain(NOW);
  });

  it('drops partitions older than the retention window and keeps the boundary day', async () => {
    await store.ensurePartitions([-40, -31, -30, -29, -1].map((d) => addDays(TODAY, d)));
    const dropped = await store.dropExpired(NOW);

    expect(dropped).toBe(2); // -40 and -31; -30 is the oldest day still inside 30 days
    const left = await tables();
    expect(left).not.toContain(partitionName(addDays(TODAY, -40)));
    expect(left).not.toContain(partitionName(addDays(TODAY, -31)));
    expect(left).toContain(partitionName(addDays(TODAY, -30)));
    expect(left).toContain(partitionName(addDays(TODAY, -29)));
  });

  it('a row lands in its own day partition, and the dedupe key rejects a repeat', async () => {
    const insert = (ts: string, key: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO public.og_traffic_search (ts, apiid, dedupe_key) VALUES ($1::timestamptz, 'a1', $2) ON CONFLICT (ts, dedupe_key) DO NOTHING`,
        ts,
        key,
      );
    expect(await insert('2026-09-29T10:00:00Z', 'k1')).toBe(1);
    expect(await insert('2026-09-29T10:00:00Z', 'k1')).toBe(0);
    expect(await insert('2026-09-29T10:00:00Z', 'k2')).toBe(1);
    const where = await prisma.$queryRaw<{ t: string }[]>`SELECT tableoid::regclass::text AS t FROM public.og_traffic_search WHERE dedupe_key = 'k1'`;
    expect(where[0]?.t).toBe('og_traffic_search_20260929');
    const ids = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(DISTINCT id)::bigint AS n FROM public.og_traffic_search`;
    expect(Number(ids[0]?.n)).toBe(2); // the sequence hands out distinct ids across partitions
  });

  it('a 24h word search skips the old partitions and is answered by the full-text index', async () => {
    const days = [-20, -10, -5, -1, 0];
    for (const d of days) {
      await store.ensurePartitions([addDays(TODAY, d)]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.og_traffic_search (ts, apiid, dedupe_key, res_body, fts)
         SELECT $1::timestamptz + (b.g || ' seconds')::interval, 'a1', 'w' || $2 || '-' || b.g,
                b.body, to_tsvector('simple', b.body)
           FROM (SELECT g, CASE WHEN g % 25 = 0 THEN 'payment declined: insufficient funds for order ' || g ELSE 'payment accepted for order ' || g END AS body
                   FROM generate_series(1, 400) g) b`,
        addDays(TODAY, d).toISOString().replace('T00:00:00.000Z', 'T06:00:00Z'),
        String(d),
      );
    }
    await prisma.$executeRawUnsafe('ANALYZE public.og_traffic_search');

    const request = validateSearchRequest({ range: '24h', clauses: [{ kind: 'body', side: 'any', value: 'insufficient funds' }] });
    const q = trafficSearchQuery({ request, tykApiIds: ['a1'], resolveApi: () => [], now: NOW });
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN ${q.text}`, ...q.values);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });

    for (const old of [-20, -10, -5]) expect(plan).not.toContain(partitionName(addDays(TODAY, old)));
    expect(plan).toContain(partitionName(TODAY));
    expect(plan).toMatch(/Index Scan|Bitmap Index Scan/);
    expect(plan).toMatch(/fts @@/); // the stored vector is what is matched,
    expect(plan).not.toMatch(/to_tsvector/); // and no vector is computed per row
    // On 400 rows a day the planner is right to walk the ts index, so whether the GIN index is chosen is the 30-day test's question; this one
    // asks only that the index can answer the predicate: with nothing else to use, it is what the planner reaches for.
    const bare = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN SELECT id FROM public.og_traffic_search WHERE fts @@ phraseto_tsquery('simple', 'insufficient funds')`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(bare).toMatch(/Bitmap Index Scan on \S*fts_idx/);

    const found = await prisma.$queryRawUnsafe<{ id: bigint }[]>(q.text, ...q.values);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(51);
  });

  it('a side-specific search still matches and the other side does not', async () => {
    const run = async (side: 'req' | 'res') => {
      const request = validateSearchRequest({ range: '24h', clauses: [{ kind: 'body', side, value: 'insufficient funds' }] });
      const q = trafficSearchQuery({ request, tykApiIds: ['a1'], resolveApi: () => [], now: NOW });
      return prisma.$queryRawUnsafe<{ id: bigint }[]>(q.text, ...q.values);
    };
    expect((await run('res')).length).toBeGreaterThan(0);
    expect((await run('req')).length).toBe(0); // the words are only in response bodies
  });

  /**
   * The plan, left to the planner: no `enable_seqscan = off`, a month of daily partitions, bodies that are TOASTed, and a
   * phrase in 1 row in 20. Forcing the plan (as the 24h test above does, on 2,000 tiny rows) would pass whichever plan
   * the planner would really pick. On 120k rows the same query against the old expression index measured 7.0 s at 30 days
   * (the index finds the rows, then every candidate recomputes `to_tsvector` over its bodies); against the stored vector, 0.6 s.
   */
  it('a 30-day search for a moderately common phrase is answered by the GIN index on the stored vector, with nothing computed per row', async () => {
    // A table of its own: the planner's word statistics must come from these rows alone (the test above stored a phrase that every row has).
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
    await store.maintain(NOW);
    await store.ensurePartitions(Array.from({ length: 31 }, (_, i) => addDays(TODAY, -i)));
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.og_traffic_search (ts, apiid, method, path, dedupe_key, res_body, fts)
       SELECT b.ts, 'a1', 'POST', '/orders', 'bulk-' || b.g, b.body, to_tsvector('simple', b.body)
         FROM (SELECT g, $1::timestamptz - (g * interval '43 seconds') AS ts,
                      '{"trace":"' || repeat(md5(g::text), 40) || '","reason":"' || CASE WHEN g % 20 = 0 THEN 'insufficient funds' ELSE 'other' END || '"}' AS body
                 FROM generate_series(1, 60000) g) b`,
      NOW.toISOString(),
    );
    await prisma.$executeRawUnsafe('ANALYZE public.og_traffic_search');

    const request = validateSearchRequest({ range: '30d', clauses: [{ kind: 'body', side: 'any', value: 'insufficient funds' }] });
    const q = trafficSearchQuery({ request, tykApiIds: ['a1'], resolveApi: () => [], now: NOW });
    const plan = (await prisma.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN ${q.text}`, ...q.values)).map((r) => r['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Bitmap Index Scan on \S*fts_idx/);
    expect(plan).not.toMatch(/to_tsvector/);
    expect(plan).not.toMatch(/Index Scan (Backward )?using \S*apiid_ts/); // not a walk of the window with a filter per row
    const found = await prisma.$queryRawUnsafe<{ id: bigint }[]>(q.text, ...q.values);
    expect(found).toHaveLength(51);
  }, 240_000); // building 60,000 TOASTed rows with their GIN indexes takes 20 s on an idle machine and several times that on a busy one
});
