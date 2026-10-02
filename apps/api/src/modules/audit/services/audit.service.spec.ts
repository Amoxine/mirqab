import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AnalyticsService } from '../../analytics/services/analytics.service';
import type { RollupRow } from '../../analytics/services/pump-query.builder';
import { AnalyticsRange } from '../../analytics/dto/analytics-query.dto';
import { AuditService, CSV_MAX_ROWS } from './audit.service';

interface AuditRow {
  createdAt: Date;
  user: { name: string } | null;
  action: string;
  resource: string;
  ipAddress: string | null;
  corrId: string | null;
  details: unknown;
}

const row = (overrides: Partial<AuditRow> = {}): AuditRow => ({
  createdAt: new Date('2026-01-05T10:00:00.000Z'),
  user: { name: 'Ada' },
  action: 'UPDATED',
  resource: 'apis',
  ipAddress: '10.0.0.1',
  corrId: 'corr-1',
  details: { resourceId: 'api-1' },
  ...overrides,
});

/** The shape of the findMany/count args this suite asserts on. */
interface QueryArgs {
  where: Record<string, unknown>;
  skip?: number;
  take?: number;
}

/** Captures the args AuditService hands Prisma, so the where clause itself can be asserted. */
function makeService(rows: AuditRow[] = [], analyticsService: Partial<AnalyticsService> = {}) {
  const findMany = jest.fn((_args: QueryArgs) => Promise.resolve(rows));
  const count = jest.fn((_args: QueryArgs) => Promise.resolve(rows.length));
  const findFirst = jest
    .fn<Promise<{ tykApiId: string | null } | null>, [{ where: { id: string; tenantId: string } }]>()
    .mockResolvedValue(null);
  const service = new AuditService(analyticsService as AnalyticsService);

  const findUnique = jest.fn((_args: { where: Record<string, unknown>; include?: unknown }) => Promise.resolve(null));

  (service as unknown as { prisma: PrismaClient }).prisma = {
    auditLog: { findMany, count, findUnique, groupBy: jest.fn() },
    apiDefinition: { findFirst },
  } as unknown as PrismaClient;

  return { service, findMany, count, findFirst, findUnique };
}

// A1: `where = { tenantId }` with an undefined tenantId is a where clause Prisma DROPS, so a
// tenant-less token (POST /auth/register mints one) read every tenant's rows.
describe('AuditService tenant scoping', () => {
  it.each([
    ['findAll', (s: AuditService) => s.findAll(undefined)],
    ['findOne', (s: AuditService) => s.findOne(1n, undefined)],
    ['exportCsv', (s: AuditService) => s.exportCsv(undefined)],
    ['getStats', (s: AuditService) => s.getStats(undefined)],
  ])('%s refuses a request with no tenant', async (_name, call) => {
    const { service, findMany } = makeService();

    await expect(call(service)).rejects.toThrow(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([[''], [undefined]])('treats %p as no tenant at all', async (tenantId) => {
    const { service } = makeService();

    await expect(service.findAll(tenantId)).rejects.toThrow('no tenant context');
  });

  it('scopes the query to the caller’s tenant', async () => {
    const { service, findMany } = makeService();

    await service.findAll('t1');

    expect(findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1' });
  });
});

// The cross-tenant guard of GET /audit-logs/:id: ids are sequential, so the lookup must be bound to the
// caller's tenant or any signed-in user could read any tenant's entries by counting.
describe('AuditService.findOne', () => {
  it('looks the entry up by id AND the caller’s tenant, never by id alone', async () => {
    const { service, findUnique } = makeService();

    await service.findOne(17n, 'tenant-1');

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0][0].where).toEqual({ id: 17n, tenantId: 'tenant-1' });
  });

  it('asks for the user’s name and email only, not the whole user row', async () => {
    const { service, findUnique } = makeService();

    await service.findOne(17n, 'tenant-1');

    expect(findUnique.mock.calls[0][0].include).toEqual({ user: { select: { name: true, email: true } } });
  });

  it('gives back nothing for another tenant’s entry (the scoped lookup finds none)', async () => {
    const { service } = makeService();

    await expect(service.findOne(17n, 'tenant-2')).resolves.toBeNull();
  });
});

describe('AuditService.findAll pagination', () => {
  it.each([
    [0, 1, 0],
    [-5, 1, 0],
    [3, 3, 40],
  ])('clamps page %i to %i (skip %i)', async (requested, page, skip) => {
    const { service, findMany } = makeService();

    const result = await service.findAll('t1', { page: requested, pageSize: 20 });

    expect(findMany.mock.calls[0][0].skip).toBe(skip);
    expect(result.meta.page).toBe(page);
  });

  it.each([
    [0, 1],
    [5000, 100],
    [50, 50],
  ])('clamps pageSize %i to %i', async (requested, expected) => {
    const { service, findMany } = makeService();

    const result = await service.findAll('t1', { pageSize: requested });

    expect(findMany.mock.calls[0][0].take).toBe(expected);
    expect(result.meta.pageSize).toBe(expected);
  });

  it('ignores an action that is not an AuditAction instead of letting Prisma throw', async () => {
    const { service, findMany } = makeService();

    await service.findAll('t1', { action: 'DROP TABLE' });

    expect(findMany.mock.calls[0][0].where.action).toBeUndefined();
  });

  describe('apiId', () => {
    const API = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

    it('scopes to the `apis` rows that carry that id, inside the tenant', async () => {
      const { service, findMany } = makeService();
      await service.findAll('t1', { apiId: API });
      expect(findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: 't1',
        resource: 'apis',
        details: { path: ['resourceId'], equals: API },
      });
    });

    it('wins over a substring resource filter, which it would otherwise contradict', async () => {
      const { service, findMany } = makeService();
      await service.findAll('t1', { apiId: API, resource: 'keys' });
      expect(findMany.mock.calls[0][0].where.resource).toBe('apis');
    });

    it('adds nothing when absent', async () => {
      const { service, findMany } = makeService();
      await service.findAll('t1', {});
      expect(findMany.mock.calls[0][0].where.details).toBeUndefined();
    });

    it('still refuses a call with no tenant', async () => {
      const { service } = makeService();
      await expect(service.findAll(undefined, { apiId: API })).rejects.toThrow('no tenant context');
    });
  });

  it('keeps a valid action', async () => {
    const { service, findMany } = makeService();

    await service.findAll('t1', { action: 'SYNC_FAILED' });

    expect(findMany.mock.calls[0][0].where.action).toBe('SYNC_FAILED');
  });
});

// A2: `lte: dateTo` resolved to midnight, so a one-day range returned nothing.
describe('AuditService date range', () => {
  it('makes dateTo inclusive of the whole day', async () => {
    const { service, findMany } = makeService();

    await service.findAll('t1', {
      dateFrom: new Date('2026-01-05'),
      dateTo: new Date('2026-01-05'),
    });

    expect(findMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-01-05T00:00:00.000Z'),
      lt: new Date('2026-01-06T00:00:00.000Z'),
    });
  });

  it('applies the same bound to the CSV export', async () => {
    const { service, findMany } = makeService();

    await service.exportCsv('t1', { dateTo: new Date('2026-01-31') });

    expect(findMany.mock.calls[0][0].where.createdAt).toEqual({
      lt: new Date('2026-02-01T00:00:00.000Z'),
    });
  });

  it('omits the filter entirely when no dates are given', async () => {
    const { service, findMany } = makeService();

    await service.exportCsv('t1');

    expect(findMany.mock.calls[0][0].where.createdAt).toBeUndefined();
  });
});

// csvCell itself moved to common/utils/csv.ts (+ its own csv.spec.ts) to break the AnalyticsService
// <-> AuditService import cycle; this file keeps only the tests that exercise AuditService's own use
// of it (header/row quoting, formula-in-a-real-field escaping), not the function's own unit tests.
describe('AuditService.exportCsv', () => {
  it('quotes the header and every row, separated by CRLF', async () => {
    const { service } = makeService([row()]);

    const csv = await service.exportCsv('t1');
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe(
      '"Timestamp","User","Action","Resource","IP Address","Correlation ID","Details"',
    );
    expect(lines[1]).toBe(
      '"2026-01-05T10:00:00.000Z","Ada","UPDATED","apis","10.0.0.1","corr-1","{""resourceId"":""api-1""}"',
    );
  });

  it('escapes a resource crafted to break out of its field', async () => {
    const { service } = makeService([row({ resource: 'a","b', user: null, ipAddress: null, corrId: null })]);

    const csv = await service.exportCsv('t1');

    expect(csv.split('\r\n')[1]).toBe(
      '"2026-01-05T10:00:00.000Z","System","UPDATED","a"",""b","","","{""resourceId"":""api-1""}"',
    );
  });

  it('neutralises a formula stored in an audited field', async () => {
    const { service } = makeService([row({ resource: '=HYPERLINK("http://evil","click")' })]);

    const csv = await service.exportCsv('t1');

    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
  });

  it('caps the number of exported rows', async () => {
    const { service, findMany } = makeService();

    await service.exportCsv('t1');

    expect(findMany.mock.calls[0][0].take).toBe(CSV_MAX_ROWS);
    expect(CSV_MAX_ROWS).toBe(10_000);
  });
});

describe('AuditService.record / recordOrThrow', () => {
  const entry = { action: 'UPDATED' as const, resource: 'ApiDefinition', details: { x: 1 } };
  interface CreateMock {
    auditLog: { create: jest.Mock };
  }

  /** The mock client `makeService` injected — i.e. the service's "shared" client in these tests. */
  const sharedClientOf = (service: AuditService) => (service as unknown as { prisma: CreateMock }).prisma;

  it('record() swallows a write failure and still resolves — the fire-and-forget path', async () => {
    const { service } = makeService();
    sharedClientOf(service).auditLog.create = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(service.record(entry)).resolves.toBeUndefined();
  });

  it('record() writes through the shared client — the explicit argument replaced the old default', async () => {
    const { service } = makeService();
    const create = jest.fn().mockResolvedValue(undefined);
    sharedClientOf(service).auditLog.create = create;

    await service.record(entry);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('recordOrThrow() rejects on a write failure instead of swallowing it', async () => {
    const { service } = makeService();
    const shared = sharedClientOf(service);
    shared.auditLog.create = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(service.recordOrThrow(entry, shared as unknown as Parameters<typeof service.recordOrThrow>[1])).rejects.toThrow('db down');
  });

  // WP25's adopt-from-gateway is the reason this parameter exists: worker-8 verified live that
  // recordOrThrow() alone does not roll back a sibling write when the audit insert fails — only
  // wrapping both in one prisma.$transaction and writing the audit row THROUGH that transaction's
  // client does. This is the unit-level guarantee the wiring makes that possible.
  it('recordOrThrow() writes through the supplied transaction client, not the shared one', async () => {
    const { service } = makeService();
    const sharedCreate = jest.fn();
    sharedClientOf(service).auditLog.create = sharedCreate;
    const txCreate = jest.fn().mockResolvedValue(undefined);
    const tx = { auditLog: { create: txCreate } } as unknown as Parameters<typeof service.recordOrThrow>[1];

    await service.recordOrThrow(entry, tx);

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(sharedCreate).not.toHaveBeenCalled();
  });

  // worker-8's empirical footgun: `tx` used to default to the shared client, so a caller inside a
  // transaction who forgot it wrote on a DIFFERENT connection and left an audit row for a change that
  // never committed (1 row surviving a rolled-back transaction) — silently. It is required now.
  // Two independent guards, so neither can regress unnoticed: the compile-time one fails the build if
  // `tx` becomes optional again (an unused @ts-expect-error is itself an error), and the runtime one
  // fails the test if a missing `tx` ever falls through to the shared client again.
  it('has no default for tx: omitting it is a compile error and never falls back to the shared client', async () => {
    const { service } = makeService();
    const sharedCreate = jest.fn().mockResolvedValue(undefined);
    sharedClientOf(service).auditLog.create = sharedCreate;

    // @ts-expect-error tx is required on purpose; this line must NOT compile if the parameter turns optional again
    const omitted = service.recordOrThrow(entry);

    await expect(omitted).rejects.toThrow();
    expect(sharedCreate).not.toHaveBeenCalled();
  });
});

// AC-LOG01.1/.3: apiDefId -> tykApiId is resolved inside a tenant-scoped query; a client-supplied
// tykApiId or a cross-tenant apiDefId must never reach the Pump rollup.
describe('AuditService.findRelatedTraffic', () => {
  it('refuses a request with no tenant and never queries', async () => {
    const loadApiRollup = jest.fn();
    const { service, findFirst } = makeService([], { loadApiRollup });

    await expect(
      service.findRelatedTraffic(undefined, 'api-1', AnalyticsRange.ONE_DAY),
    ).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
    expect(loadApiRollup).not.toHaveBeenCalled();
  });

  it('resolves apiDefId to a tykApiId scoped to the caller’s own tenant', async () => {
    const loadApiRollup = jest.fn().mockResolvedValue([]);
    const { service, findFirst } = makeService([], { loadApiRollup });

    await service.findRelatedTraffic('t1', 'api-1', AnalyticsRange.ONE_DAY);

    expect(findFirst.mock.calls[0][0].where).toEqual({ id: 'api-1', tenantId: 't1' });
  });

  // Simulates a cross-tenant apiDefId (AC-LOG01.3): the tenant-scoped lookup finds nothing, so the
  // caller must never fall through to an unscoped or client-supplied tykApiId query.
  it('returns a zeroed result and never queries Pump when the api is not owned by this tenant', async () => {
    const loadApiRollup = jest.fn();
    const { service, findFirst } = makeService([], { loadApiRollup });
    findFirst.mockResolvedValue(null);

    const result = await service.findRelatedTraffic('t1', 'api-1', AnalyticsRange.ONE_DAY);

    expect(loadApiRollup).not.toHaveBeenCalled();
    expect(result).toEqual({
      apiDefId: 'api-1',
      range: AnalyticsRange.ONE_DAY,
      requests: 0,
      errors: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      avgUpstreamLatencyMs: 0,
    });
  });

  // AC-LOG01.3, at the bar of AC-LOG02.3/AC-USR01.1: a REAL two-tenant fixture, not a canned null. Two
  // genuine rows (their own real ids, own tenants, own Tyk ids) so `findFirst` actually has to pick
  // one — this fails if the lookup is ever split into an id-only query plus a separate/loose tenant
  // check (team-lead's regression scenario), because that shape would still resolve tenant B's row.
  it('never surfaces tenant B’s rollup when tenant A asks for tenant B’s own real apiDefId', async () => {
    const fixtures = [
      { id: 'api-uuid-a', tenantId: 't1', tykApiId: 'tyk-a' },
      { id: 'api-uuid-b', tenantId: 't2', tykApiId: 'tyk-b' },
    ];
    const rollupOf = (tykApiId: string): RollupRow => ({
      dimension_value: tykApiId,
      requests: tykApiId === 'tyk-a' ? 5 : 999_999,
      success: tykApiId === 'tyk-a' ? 5 : 999_999,
      errors: 0,
      avg_latency_ms: 1,
      avg_upstream_ms: 1,
    });
    const loadApiRollup = jest.fn((tykApiIds: string[], _window: unknown, _limit?: number) =>
      Promise.resolve(tykApiIds.map(rollupOf)),
    );
    const { service, findFirst } = makeService([], { loadApiRollup });
    // A real lookup, not a stub returning the same thing regardless of args: only a matching
    // (id, tenantId) PAIR resolves, exactly like a unique-id table two tenants both have a row in.
    findFirst.mockImplementation((args) =>
      Promise.resolve(fixtures.find((f) => f.id === args.where.id && f.tenantId === args.where.tenantId) ?? null),
    );

    // Tenant A asks for tenant B's real, existing apiDefId — not a dropped filter, an actual other
    // tenant's row that genuinely exists and genuinely has traffic.
    const leaked = await service.findRelatedTraffic('t1', 'api-uuid-b', AnalyticsRange.ONE_DAY);
    expect(leaked.requests).toBe(0);
    expect(loadApiRollup).not.toHaveBeenCalled();

    // Sanity: the fixture is genuinely wired to tell tenants apart — tenant A's OWN id does surface
    // tenant A's own (much smaller) numbers, proving the zero above isn't just "always empty".
    const own = await service.findRelatedTraffic('t1', 'api-uuid-a', AnalyticsRange.ONE_DAY);
    expect(own.requests).toBe(5);
  });

  it('returns zeros when the api has never synced a tykApiId', async () => {
    const loadApiRollup = jest.fn();
    const { service, findFirst } = makeService([], { loadApiRollup });
    findFirst.mockResolvedValue({ tykApiId: null });

    const result = await service.findRelatedTraffic('t1', 'api-1', AnalyticsRange.ONE_DAY);

    expect(loadApiRollup).not.toHaveBeenCalled();
    expect(result.requests).toBe(0);
  });

  it('queries only the resolved tykApiId, never a client-supplied one', async () => {
    const loadApiRollup = jest
      .fn<Promise<RollupRow[]>, [string[], unknown, number?]>()
      .mockResolvedValue([]);
    const { service, findFirst } = makeService([], { loadApiRollup });
    findFirst.mockResolvedValue({ tykApiId: 'tyk-42' });

    await service.findRelatedTraffic('t1', 'api-1', AnalyticsRange.ONE_DAY);

    expect(loadApiRollup.mock.calls[0][0]).toEqual(['tyk-42']);
  });

  it('maps a rollup row into the rounded response shape', async () => {
    const loadApiRollup = jest.fn().mockResolvedValue([
      {
        dimension_value: 'tyk-42',
        requests: 200,
        success: 190,
        errors: 10,
        avg_latency_ms: 12.345,
        avg_upstream_ms: 8.111,
      },
    ]);
    const { service, findFirst } = makeService([], { loadApiRollup });
    findFirst.mockResolvedValue({ tykApiId: 'tyk-42' });

    const result = await service.findRelatedTraffic('t1', 'api-1', AnalyticsRange.SEVEN_DAYS);

    expect(result).toEqual({
      apiDefId: 'api-1',
      range: AnalyticsRange.SEVEN_DAYS,
      requests: 200,
      errors: 10,
      errorRate: 5,
      avgLatencyMs: 12.35,
      avgUpstreamLatencyMs: 8.11,
    });
  });

  it('returns zeros when the rollup has no row for the window', async () => {
    const loadApiRollup = jest.fn().mockResolvedValue([]);
    const { service, findFirst } = makeService([], { loadApiRollup });
    findFirst.mockResolvedValue({ tykApiId: 'tyk-42' });

    const result = await service.findRelatedTraffic('t1', 'api-1', AnalyticsRange.ONE_DAY);

    expect(result.requests).toBe(0);
    expect(result.errorRate).toBe(0);
  });
});
