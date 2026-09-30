import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { AnalyticsController } from '../controllers/analytics.controller';
import type { TrafficSearchIndexerService } from './traffic-search.indexer.service';
import { TrafficSearchService } from './traffic-search.service';

interface Captured {
  text: string;
  values: unknown[];
}

function setup(options: { apis?: { id: string; name: string; slug: string; tykApiId: string | null }[]; rows?: unknown[]; fail?: Error; timeout?: string } = {}) {
  const apis = options.apis ?? [
    { id: 'def-1', name: 'Orders API', slug: 'orders', tykApiId: 'tyk-a' },
    { id: 'def-2', name: 'Payments', slug: 'payments', tykApiId: 'tyk-b' },
    { id: 'def-3', name: 'Never synced', slug: 'draft', tykApiId: null },
  ];
  const captured: Captured[] = [];
  const executed: string[] = [];
  const tx = {
    $executeRawUnsafe: (sql: string) => {
      executed.push(sql);
      return Promise.resolve(0);
    },
    $queryRaw: (q: Captured) => {
      captured.push(q);
      return options.fail ? Promise.reject(options.fail) : Promise.resolve(options.rows ?? []);
    },
  };
  const findMany = jest.fn().mockResolvedValue(apis.filter((a) => a.tykApiId !== null));
  const prisma = {
    apiDefinition: { findMany },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  const config = { get: (k: string) => (k === 'TRAFFIC_SEARCH_TIMEOUT_MS' ? options.timeout : undefined) } as unknown as ConfigService;
  const indexer = { indexedUntil: () => Promise.resolve(new Date('2026-09-29T11:59:50.000Z')) } as unknown as TrafficSearchIndexerService;
  return { service: new TrafficSearchService(prisma, config, indexer), captured, executed, findMany };
}

const listRow = (id: number, tsIso = '2026-09-29T10:00:00.123456Z', apiid = 'tyk-a') => ({
  id: BigInt(id),
  ts_iso: tsIso,
  apiid,
  method: 'POST',
  path: '/orders',
  status: 402,
  latency_ms: 340,
  key_alias: 'qbus-web',
  req_truncated: false,
  res_truncated: true,
});

describe('TrafficSearchService.search', () => {
  it('refuses an invalid request with a code a client can switch on', async () => {
    const { service, captured } = setup();
    const message: unknown = expect.stringContaining('Unknown filter kind');
    await expect(service.search('t1', { clauses: [{ kind: 'sql', value: '1=1' }] })).rejects.toMatchObject({
      response: { error: 'SEARCH_INVALID', message },
    });
    await expect(service.search('t1', 'nope')).rejects.toBeInstanceOf(BadRequestException);
    expect(captured).toHaveLength(0); // nothing reached the database
  });

  it('scopes the query to the tenant\'s synced APIs and to nothing else', async () => {
    const { service, captured, findMany } = setup();
    await service.search('tenant-A', {});
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-A', tykApiId: { not: null } },
      select: { id: true, name: true, slug: true, tykApiId: true },
    });
    expect(captured[0]?.values[0]).toEqual(['tyk-a', 'tyk-b']);
  });

  it('resolves an api: clause by id, name or slug, case-insensitively, and only inside the tenant', async () => {
    for (const value of ['def-1', 'ORDERS API', 'Orders']) {
      const { service, captured } = setup();
      await service.search('t1', { clauses: [{ kind: 'api', value }] });
      expect(captured[0]?.values[2]).toEqual(['tyk-a']);
    }
    const { service, captured } = setup();
    await service.search('t1', { clauses: [{ kind: 'api', value: 'someone-elses-api' }] });
    expect(captured[0]?.values[2]).toEqual([]); // matches nothing rather than widening
  });

  it('a tenant with no synced API gets an empty page without touching the search table', async () => {
    const { service, captured } = setup({ apis: [{ id: 'd', name: 'Draft', slug: 'draft', tykApiId: null }] });
    const page = await service.search('t1', {});
    expect(page).toMatchObject({ items: [], hasMore: false, nextCursor: null });
    expect(captured).toHaveLength(0);
  });

  it('returns the page, its cursor, and how far the indexer has caught up', async () => {
    const rows = [listRow(9, '2026-09-29T10:00:03.000001Z'), listRow(8, '2026-09-29T10:00:02.000002Z'), listRow(7, '2026-09-29T10:00:01.000003Z')];
    const { service } = setup({ rows });
    const page = await service.search('t1', { limit: 2 });

    expect(page.items.map((i) => i.id)).toEqual(['9', '8']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ ts: '2026-09-29T10:00:02.000002Z', id: '8' }); // the last KEPT row, microseconds intact
    expect(page.indexedUntil).toBe('2026-09-29T11:59:50.000Z');
    expect(page.items[0]).toEqual({
      id: '9',
      ts: '2026-09-29T10:00:03.000001Z',
      apiId: 'def-1',
      apiName: 'Orders API',
      method: 'POST',
      path: '/orders',
      status: 402,
      latencyMs: 340,
      keyAlias: 'qbus-web',
      reqTruncated: false,
      resTruncated: true,
    });
  });

  it('the last page has no cursor', async () => {
    const { service } = setup({ rows: [listRow(1)] });
    expect(await service.search('t1', { limit: 5 })).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('applies the time budget inside the transaction, from config and clamped', async () => {
    expect((await runWith('2500')).executed).toEqual(['SET LOCAL statement_timeout = 2500']);
    expect((await runWith(undefined)).executed).toEqual(['SET LOCAL statement_timeout = 3000']);
    expect((await runWith('1')).executed).toEqual(['SET LOCAL statement_timeout = 100']);
    expect((await runWith('999999')).executed).toEqual(['SET LOCAL statement_timeout = 10000']);
    expect((await runWith('3000; DROP TABLE x')).executed).toEqual(['SET LOCAL statement_timeout = 3000']);

    async function runWith(timeout: string | undefined) {
      const s = setup({ timeout });
      await s.service.search('t1', {});
      return s;
    }
  });

  it.each([
    ['a Postgres statement timeout', new Error('canceling statement due to statement timeout')],
    ['SQLSTATE 57014 in the text', new Error('Raw query failed. Code: `57014`. Message: `canceling statement`')],
  ])('maps %s to 422 SEARCH_TOO_BROAD', async (_label, fail) => {
    const { service } = setup({ fail });
    await expect(service.search('t1', {})).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.search('t1', {})).rejects.toMatchObject({ response: { error: 'SEARCH_TOO_BROAD' } });
  });

  it('lets any other database error through unchanged', async () => {
    const { service } = setup({ fail: new Error('connection refused') });
    await expect(service.search('t1', {})).rejects.toThrow('connection refused');
  });
});

describe('TrafficSearchService.detail', () => {
  const detailRow = { ...listRow(5), ip: '10.0.0.7', req_headers: { 'x-a': '1' }, res_headers: {}, req_body: 'req', res_body: 'res' };

  it('returns one row with its headers and bodies, scoped to the tenant', async () => {
    const { service, captured } = setup({ rows: [detailRow] });
    const out = await service.detail('t1', '5', '2026-09-29T10:00:00.123456Z');
    expect(out).toMatchObject({ id: '5', ip: '10.0.0.7', reqHeaders: { 'x-a': '1' }, reqBody: 'req', resBody: 'res', apiName: 'Orders API' });
    expect(captured[0]?.values).toEqual([['tyk-a', 'tyk-b'], '2026-09-29T10:00:00.123456Z', '5']);
  });

  it('is 404 for a row the tenant cannot see, whatever the reason', async () => {
    await expect(setup({ rows: [] }).service.detail('t1', '5', '2026-09-29T10:00:00Z')).rejects.toBeInstanceOf(NotFoundException);
    const none = setup({ apis: [] });
    await expect(none.service.detail('t1', '5', '2026-09-29T10:00:00Z')).rejects.toBeInstanceOf(NotFoundException);
    expect(none.captured).toHaveLength(0);
  });

  it.each([
    ['a non-numeric id', '5; DROP TABLE x', '2026-09-29T10:00:00Z'],
    ['a missing ts', '5', undefined as unknown as string],
    ['a ts that is not ISO', '5', 'yesterday'],
  ])('rejects %s before any query', async (_label, id, ts) => {
    const { service, captured } = setup({ rows: [detailRow] });
    await expect(service.detail('t1', id, ts)).rejects.toBeInstanceOf(BadRequestException);
    expect(captured).toHaveLength(0);
  });
});

describe('AnalyticsController permissions for search', () => {
  /** The handler function itself, read without calling it (a method reference trips the unbound-method rule). */
  const fn = (handler: keyof AnalyticsController): object => Object.getOwnPropertyDescriptor(AnalyticsController.prototype, handler)?.value as object;
  const required = (handler: keyof AnalyticsController) => Reflect.getMetadata(PERMISSIONS_KEY, fn(handler)) as string[] | undefined;

  it('needs analytics:read AND api:update, the same bar as the per-API captured-traffic inspector', () => {
    expect(required('searchTraffic')).toEqual(['analytics:read', 'api:update']);
    expect(required('searchTrafficDetail')).toEqual(['analytics:read', 'api:update']);
  });

  it('the controller default is still analytics:read, so the existing routes are unchanged', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AnalyticsController)).toEqual(['analytics:read']);
    expect(required('getOverview')).toBeUndefined();
  });

  it('writes no audit row: the global audit interceptor only acts on handlers marked with @Audit, and these are not', () => {
    // A read-only POST. Decision recorded in the plan (section 12, item 3): searches are not audited for
    // now. Revisit if reading captured bodies needs an audit trail; this test then fails on purpose.
    expect(Reflect.getMetadata(AUDIT_KEY, fn('searchTraffic'))).toBeUndefined();
    expect(Reflect.getMetadata(AUDIT_KEY, fn('searchTrafficDetail'))).toBeUndefined();
  });
});
