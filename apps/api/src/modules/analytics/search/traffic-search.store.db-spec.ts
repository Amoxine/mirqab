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
      'og_traffic_search_fts',
      'og_traffic_search_req_headers',
      'og_traffic_search_res_headers',
    ]);
    const state = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM public.og_traffic_search_state`;
    expect(Number(state[0]?.n)).toBe(0);
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
        `INSERT INTO public.og_traffic_search (ts, apiid, dedupe_key, res_body)
         SELECT $1::timestamptz + (g || ' seconds')::interval, 'a1', 'w' || $2 || '-' || g,
                'payment declined: insufficient funds for order ' || g
           FROM generate_series(1, 400) g`,
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
    expect(plan).toMatch(/tsvector/); // the full-text expression index, not a scan of the body column

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
});
