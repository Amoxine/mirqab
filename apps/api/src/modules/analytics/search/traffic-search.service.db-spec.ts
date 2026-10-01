import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { TrafficSearchIndexerService } from './traffic-search.indexer.service';
import { queryWithTimeout, SearchTimeoutError } from './traffic-search.query';
import { TrafficSearchService } from './traffic-search.service';
import { TrafficSearchStoreService } from './traffic-search.store.service';

/**
 * The search endpoint's tenant boundary, keyset paging and time budget against a REAL Postgres. Both
 * tenants hold rows that share EVERY searchable value, so a scoping mistake in any clause shows up as a
 * foreign row. Not part of `jest` (the name does not match `.spec.ts`): it needs a THROWAWAY database.
 *
 *   docker run -d --rm --name og-probe-search-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55451:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55451/t?schema=public'
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'traffic-search\.service\.db-spec\.ts$')
 *   docker rm -f og-probe-search-pg
 */

jest.setTimeout(120_000);

const NOW = new Date('2026-09-29T12:00:00.000Z');
const APIS: Record<string, { id: string; name: string; slug: string; tykApiId: string }[]> = {
  'tenant-A': [{ id: 'def-a', name: 'Orders A', slug: 'orders-a', tykApiId: 'tyk-a' }],
  'tenant-B': [{ id: 'def-b', name: 'Orders B', slug: 'orders-b', tykApiId: 'tyk-b' }],
};

describe('traffic search service on a real Postgres', () => {
  const config = { get: () => undefined } as unknown as ConfigService;
  const stubbed = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'apiDefinition') {
        return { findMany: ({ where }: { where: { tenantId: string } }) => Promise.resolve(APIS[where.tenantId] ?? []) };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const store = new TrafficSearchStoreService(stubbed, config);
  const indexer = { indexedUntil: () => Promise.resolve(NOW) } as unknown as TrafficSearchIndexerService;
  const service = new TrafficSearchService(stubbed, config, indexer);

  /** Rows per tenant: identical in every searchable value, so only the apiid tells them apart. */
  const ROWS_PER_TENANT = 6;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
    await store.maintain(NOW);
    for (const apiid of ['tyk-a', 'tyk-b']) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.og_traffic_search (ts, apiid, method, path, status, latency_ms, key_alias, ip, req_headers, res_headers, req_body, res_body, dedupe_key)
         SELECT '2026-09-29T10:00:00Z'::timestamptz + (g || ' seconds')::interval, $1, 'POST', '/shared/orders', 500, 900, 'shared-key', '10.0.0.1',
                '{"x-shared":"yes"}'::jsonb, '{"x-shared":"yes"}'::jsonb, 'cross tenant needle request', 'cross tenant needle response', $1 || g
           FROM generate_series(1, ${String(ROWS_PER_TENANT)}) g`,
        apiid,
      );
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$disconnect();
  });

  /** Every clause kind, each written so that BOTH tenants' rows match it. */
  const MATCH_ALL: [string, Record<string, unknown>][] = [
    ['status', { kind: 'status', match: { type: 'cmp', op: '>=', value: 500 } }],
    ['status range', { kind: 'status', match: { type: 'range', from: 500, to: 599 } }],
    ['status list', { kind: 'status', match: { type: 'in', values: [500] } }],
    ['latency', { kind: 'latency', op: '>', value: 800 }],
    ['method', { kind: 'method', values: ['POST'] }],
    ['path prefix', { kind: 'path', value: '/shared' }],
    ['key', { kind: 'key', value: 'shared-key' }],
    ['header equals (request)', { kind: 'header', side: 'req', name: 'x-shared', value: 'yes' }],
    ['header exists (response)', { kind: 'header', side: 'res', name: 'x-shared' }],
    ['body either side', { kind: 'body', side: 'any', value: 'cross tenant needle' }],
    ['body request side', { kind: 'body', side: 'req', value: 'cross tenant needle' }],
    ['body response side', { kind: 'body', side: 'res', value: 'cross tenant needle' }],
  ];

  it('control: with no scoping at all the table really holds both tenants\' rows', async () => {
    const rows = await prisma.$queryRaw<{ apiid: string; n: bigint }[]>`SELECT apiid, count(*)::bigint AS n FROM public.og_traffic_search GROUP BY 1 ORDER BY 1`;
    expect(rows.map((r) => [r.apiid, Number(r.n)])).toEqual([['tyk-a', ROWS_PER_TENANT], ['tyk-b', ROWS_PER_TENANT]]);
  });

  it.each(MATCH_ALL)('%s: each tenant sees exactly its own rows and never the other\'s', async (_label, clause) => {
    for (const [tenant, apiId] of [['tenant-A', 'def-a'], ['tenant-B', 'def-b']] as const) {
      const page = await service.search(tenant, { range: '7d', clauses: [clause], limit: 100 });
      expect(page.items).toHaveLength(ROWS_PER_TENANT);
      expect(new Set(page.items.map((i) => i.apiId))).toEqual(new Set([apiId]));
    }
  });

  it.each(MATCH_ALL)('%s, negated: still only the tenant\'s own rows (none match, but none leak either)', async (_label, clause) => {
    for (const tenant of ['tenant-A', 'tenant-B']) {
      const page = await service.search(tenant, { range: '7d', clauses: [{ ...clause, neg: true }], limit: 100 });
      expect(page.items).toHaveLength(0);
    }
  });

  it('a negated clause that does not match returns the tenant\'s rows, not everyone\'s', async () => {
    const page = await service.search('tenant-A', { range: '7d', clauses: [{ kind: 'key', neg: true, value: 'other-key' }], limit: 100 });
    expect(page.items).toHaveLength(ROWS_PER_TENANT);
    expect(new Set(page.items.map((i) => i.apiId))).toEqual(new Set(['def-a']));
  });

  it('api: naming another tenant\'s API matches nothing, by id, name or slug', async () => {
    for (const value of ['def-b', 'Orders B', 'orders-b', 'tyk-b']) {
      const page = await service.search('tenant-A', { range: '7d', clauses: [{ kind: 'api', value }], limit: 100 });
      expect(page.items).toHaveLength(0);
    }
    const own = await service.search('tenant-A', { range: '7d', clauses: [{ kind: 'api', value: 'orders-a' }], limit: 100 });
    expect(own.items).toHaveLength(ROWS_PER_TENANT);
  });

  it('a tenant with no API of its own sees nothing', async () => {
    const page = await service.search('tenant-C', { range: '7d', clauses: [], limit: 100 });
    expect(page.items).toHaveLength(0);
  });

  it('keyset paging is stable across identical timestamps: complete, no repeats, newest first', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.og_traffic_search (ts, apiid, method, path, status, dedupe_key)
       SELECT '2026-09-29T11:00:00.000001Z', 'tyk-a', 'GET', '/tie', 200, 'tie' || g FROM generate_series(1, 120) g`,
    );
    const seen: string[] = [];
    let cursor: { ts: string; id: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await service.search('tenant-A', { range: '7d', clauses: [{ kind: 'path', value: '/tie' }], limit: 50, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((x) => x.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    const ids = seen.map(BigInt);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  });

  it('keeps the microseconds of a row\'s timestamp in the cursor', async () => {
    const page = await service.search('tenant-A', { range: '7d', clauses: [{ kind: 'path', value: '/tie' }], limit: 1 });
    expect(page.nextCursor?.ts).toBe('2026-09-29T11:00:00.000001Z');
  });

  it('detail: the owner reads a row; another tenant gets 404 for the same id', async () => {
    const page = await service.search('tenant-A', { range: '7d', clauses: [{ kind: 'key', value: 'shared-key' }], limit: 1 });
    const first = page.items.at(0);
    if (!first) throw new Error('the search returned no row to read');
    const detail = await service.detail('tenant-A', first.id, first.ts);
    expect(detail).toMatchObject({ reqHeaders: { 'x-shared': 'yes' }, reqBody: 'cross tenant needle request', ip: '10.0.0.1' });
    await expect(service.detail('tenant-B', first.id, first.ts)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.detail('tenant-C', first.id, first.ts)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a statement over its budget is cancelled and the setting does not leak to the next request', async () => {
    const started = Date.now();
    await expect(queryWithTimeout(prisma, Prisma.sql`SELECT pg_sleep(3)`, 150)).rejects.toBeInstanceOf(SearchTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000); // cancelled at ~150 ms, not after the 3 s sleep

    const after = await prisma.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(after[0]?.statement_timeout).toBe('0'); // SET LOCAL ended with its transaction
    expect(await queryWithTimeout<{ one: number }[]>(prisma, Prisma.sql`SELECT 1 AS one`, 150)).toEqual([{ one: 1 }]);
  });
});
