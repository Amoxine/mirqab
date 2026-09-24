import 'reflect-metadata';
import { prisma } from '@open-gateway/database';
import type { ApiService } from '../../api-management/services/api.service';
import { GovernanceDriftService } from './drift.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    apiDefinition: { findMany: jest.fn() },
  },
}));

interface MockDb {
  apiDefinition: { findMany: jest.Mock };
}
const db = prisma as unknown as MockDb;

const TENANT = 'tenant-1';

describe('GovernanceDriftService', () => {
  const apiService = { drift: jest.fn() };
  let service: GovernanceDriftService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new GovernanceDriftService(apiService as unknown as ApiService);
  });

  it('excludes never-synced APIs up front, matching reconcileAll', async () => {
    db.apiDefinition.findMany.mockResolvedValue([]);

    await service.report(TENANT);

    expect(db.apiDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, tykApiId: { not: null } },
        orderBy: { id: 'asc' },
      }),
    );
  });

  it('calls the existing ApiService.drift() for every candidate — no second diff implementation', async () => {
    db.apiDefinition.findMany.mockResolvedValue([
      { id: 'api-1', name: 'Orders' },
      { id: 'api-2', name: 'Payments' },
    ]);
    apiService.drift
      .mockResolvedValueOnce({ inSync: true, differences: [], perNode: {} })
      .mockResolvedValueOnce({ inSync: false, differences: ['node-2: definition differs'], perNode: {} });

    const report = await service.report(TENANT);

    expect(apiService.drift).toHaveBeenNthCalledWith(1, 'api-1', TENANT);
    expect(apiService.drift).toHaveBeenNthCalledWith(2, 'api-2', TENANT);
    expect(report.apis).toEqual([
      { apiDefId: 'api-1', name: 'Orders', inSync: true, differences: [], perNode: {} },
      { apiDefId: 'api-2', name: 'Payments', inSync: false, differences: ['node-2: definition differs'], perNode: {} },
    ]);
  });

  it('summarises in-sync vs drifted counts', async () => {
    db.apiDefinition.findMany.mockResolvedValue([
      { id: 'api-1', name: 'A' },
      { id: 'api-2', name: 'B' },
      { id: 'api-3', name: 'C' },
    ]);
    apiService.drift
      .mockResolvedValueOnce({ inSync: true, differences: [], perNode: {} })
      .mockResolvedValueOnce({ inSync: false, differences: ['x'], perNode: {} })
      .mockResolvedValueOnce({ inSync: true, differences: [], perNode: {} });

    const report = await service.report(TENANT);

    expect(report.summary).toEqual({ totalApis: 3, inSyncCount: 2, driftedCount: 1 });
  });

  it('runs sequentially, not in parallel — the second call only starts after the first resolves', async () => {
    db.apiDefinition.findMany.mockResolvedValue([
      { id: 'api-1', name: 'A' },
      { id: 'api-2', name: 'B' },
    ]);
    const order: string[] = [];
    apiService.drift.mockImplementation(async (id: string) => {
      order.push(`start:${id}`);
      await Promise.resolve();
      order.push(`end:${id}`);
      return { inSync: true, differences: [], perNode: {} };
    });

    await service.report(TENANT);

    expect(order).toEqual(['start:api-1', 'end:api-1', 'start:api-2', 'end:api-2']);
  });

  it('returns an empty report when the tenant has no synced APIs', async () => {
    db.apiDefinition.findMany.mockResolvedValue([]);

    const report = await service.report(TENANT);

    expect(report).toEqual({ apis: [], summary: { totalApis: 0, inSyncCount: 0, driftedCount: 0 } });
    expect(apiService.drift).not.toHaveBeenCalled();
  });
});
