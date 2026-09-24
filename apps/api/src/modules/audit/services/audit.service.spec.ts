import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { AuditService, CSV_MAX_ROWS, csvCell } from './audit.service';

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
function makeService(rows: AuditRow[] = []) {
  const findMany = jest.fn((_args: QueryArgs) => Promise.resolve(rows));
  const count = jest.fn((_args: QueryArgs) => Promise.resolve(rows.length));
  const service = new AuditService();

  (service as unknown as { prisma: PrismaClient }).prisma = {
    auditLog: { findMany, count, findUnique: jest.fn().mockResolvedValue(null), groupBy: jest.fn() },
  } as unknown as PrismaClient;

  return { service, findMany, count };
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

describe('csvCell', () => {
  it('quotes every field', () => {
    expect(csvCell('apis')).toBe('"apis"');
  });

  it('escapes embedded quotes by doubling them (RFC4180)', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it.each([[','], ['\n'], ['\r\n']])('keeps %p inside the quoted field', (char) => {
    expect(csvCell(`a${char}b`)).toBe(`"a${char}b"`);
  });

  // A cell starting with one of these is executed as a formula by Excel/Sheets.
  it.each([
    ['=1+1', `"'=1+1"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['=cmd|\' /c calc\'!A0', `"'=cmd|' /c calc'!A0"`],
  ])('neutralises the formula %s', (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it.each([[null], [undefined]])('renders %p as an empty quoted field', (value) => {
    expect(csvCell(value)).toBe('""');
  });
});

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

  it('record() swallows a write failure and still resolves — the fire-and-forget path', async () => {
    const { service } = makeService();
    (service as unknown as { prisma: { auditLog: { create: jest.Mock } } }).prisma.auditLog.create = jest
      .fn()
      .mockRejectedValue(new Error('db down'));

    await expect(service.record(entry)).resolves.toBeUndefined();
  });

  it('recordOrThrow() rejects on a write failure instead of swallowing it', async () => {
    const { service } = makeService();
    (service as unknown as { prisma: { auditLog: { create: jest.Mock } } }).prisma.auditLog.create = jest
      .fn()
      .mockRejectedValue(new Error('db down'));

    await expect(service.recordOrThrow(entry)).rejects.toThrow('db down');
  });

  // WP25's adopt-from-gateway is the reason this parameter exists: worker-8 verified live that
  // recordOrThrow() alone does not roll back a sibling write when the audit insert fails — only
  // wrapping both in one prisma.$transaction and writing the audit row THROUGH that transaction's
  // client does. This is the unit-level guarantee the wiring makes that possible.
  it('recordOrThrow() writes through a supplied transaction client, not the default one, when given one', async () => {
    const { service } = makeService();
    const defaultCreate = jest.fn();
    (service as unknown as { prisma: { auditLog: { create: jest.Mock } } }).prisma.auditLog.create = defaultCreate;
    const txCreate = jest.fn().mockResolvedValue(undefined);
    const tx = { auditLog: { create: txCreate } } as unknown as Parameters<typeof service.recordOrThrow>[1];

    await service.recordOrThrow(entry, tx);

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(defaultCreate).not.toHaveBeenCalled();
  });
});
