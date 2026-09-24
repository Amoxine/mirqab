import 'reflect-metadata';
import { prisma } from '@open-gateway/database';
import type { AuditEntry, AuditService } from '../../audit/services/audit.service';
import { MeteringService } from './metering.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    quota: { findMany: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

const db = prisma as unknown as {
  quota: { findMany: jest.Mock; update: jest.Mock };
  $queryRaw: jest.Mock;
};

function quotaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quota-1',
    used: 0,
    limit: 100,
    resetAt: new Date('2026-10-01T00:00:00.000Z'),
    period: 'MONTHLY',
    apiKey: { tykKeyId: 'hash-1', tenantId: 'tenant-1', id: 'key-1', name: 'Prod key' },
    ...overrides,
  };
}

describe('MeteringService — QUOTA_EXCEEDED (WP21)', () => {
  let record: jest.Mock<Promise<void>, [AuditEntry]>;
  let service: MeteringService;

  beforeEach(() => {
    jest.resetAllMocks();
    record = jest.fn<Promise<void>, [AuditEntry]>().mockResolvedValue(undefined);
    service = new MeteringService({ record } as unknown as AuditService);
    db.quota.update.mockResolvedValue({});
  });

  it('audits QUOTA_EXCEEDED exactly once on the under→over crossing', async () => {
    db.quota.findMany.mockResolvedValue([quotaRow({ used: 90, limit: 100 })]);
    db.$queryRaw.mockResolvedValue([{ dimension_value: 'hash-1', hits: 105n }]); // now over 100

    await service.meterAll();

    expect(record).toHaveBeenCalledTimes(1);
    const [entry] = record.mock.calls[0];
    expect(entry).toMatchObject({ tenantId: 'tenant-1', action: 'QUOTA_EXCEEDED', resource: 'keys' });
    expect(entry.details).toMatchObject({ apiKeyId: 'key-1', apiKeyName: 'Prod key', used: 105, limit: 100 });
    expect(db.quota.update).toHaveBeenCalledWith({ where: { id: 'quota-1' }, data: { used: 105 } });
  });

  it('does not re-audit a quota that was already over limit before this run', async () => {
    db.quota.findMany.mockResolvedValue([quotaRow({ used: 110, limit: 100 })]);
    db.$queryRaw.mockResolvedValue([{ dimension_value: 'hash-1', hits: 120n }]); // still over, further

    await service.meterAll();

    expect(record).not.toHaveBeenCalled();
    expect(db.quota.update).toHaveBeenCalledWith({ where: { id: 'quota-1' }, data: { used: 120 } });
  });

  it('does not audit a quota that stays under its limit', async () => {
    db.quota.findMany.mockResolvedValue([quotaRow({ used: 10, limit: 100 })]);
    db.$queryRaw.mockResolvedValue([{ dimension_value: 'hash-1', hits: 50n }]);

    await service.meterAll();

    expect(record).not.toHaveBeenCalled();
  });

  it('never audits or writes when used is unchanged (the existing short-circuit)', async () => {
    db.quota.findMany.mockResolvedValue([quotaRow({ used: 100, limit: 100 })]);
    db.$queryRaw.mockResolvedValue([{ dimension_value: 'hash-1', hits: 100n }]);

    await service.meterAll();

    expect(record).not.toHaveBeenCalled();
    expect(db.quota.update).not.toHaveBeenCalled();
  });
});
