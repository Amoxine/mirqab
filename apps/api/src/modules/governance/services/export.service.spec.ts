import 'reflect-metadata';
import { prisma } from '@open-gateway/database';
import { GovernanceExportService } from './export.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    apiDefinition: { findMany: jest.fn() },
    plan: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
  },
}));

interface MockDb {
  apiDefinition: { findMany: jest.Mock };
  plan: { findMany: jest.Mock };
  product: { findMany: jest.Mock };
}
const db = prisma as unknown as MockDb;

const TENANT = 'tenant-1';

describe('GovernanceExportService', () => {
  let service: GovernanceExportService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new GovernanceExportService();
  });

  it('scopes every list to the tenant and orders by id for determinism', async () => {
    db.apiDefinition.findMany.mockResolvedValue([]);
    db.plan.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([]);

    await service.export(TENANT);

    expect(db.apiDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT }, orderBy: { id: 'asc' } }),
    );
    expect(db.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT }, orderBy: { id: 'asc' } }),
    );
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT }, orderBy: { id: 'asc' } }),
    );
  });

  it('selects only config-of-record fields for an API — no tykApiId, no oasDocument, no syncState', async () => {
    db.apiDefinition.findMany.mockResolvedValue([]);
    db.plan.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([]);

    await service.export(TENANT);

    const [{ select }] = db.apiDefinition.findMany.mock.calls[0] as [{ select: Record<string, unknown> }];
    expect(select).toEqual({
      id: true,
      name: true,
      slug: true,
      proxyUrl: true,
      listenPath: true,
      authType: true,
      status: true,
      config: true,
      defFormat: true,
      versionName: true,
      parentApiId: true,
      retiredAt: true,
      createdAt: true,
      updatedAt: true,
    });
  });

  it('flattens a product’s join rows to a sorted list of api ids, not the raw join shape', async () => {
    db.apiDefinition.findMany.mockResolvedValue([]);
    db.plan.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        id: 'prod-1',
        name: 'Payments',
        slug: 'payments',
        description: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        apis: [{ apiDefId: 'api-b' }, { apiDefId: 'api-a' }],
      },
    ]);

    const bundle = await service.export(TENANT);

    expect(bundle.products).toEqual([
      {
        id: 'prod-1',
        name: 'Payments',
        slug: 'payments',
        description: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        apiIds: ['api-a', 'api-b'],
      },
    ]);
  });

  it('is deterministic: two calls over the same mocked rows produce a deep-equal bundle', async () => {
    const apiRow = {
      id: 'api-1',
      name: 'Orders',
      slug: 'orders',
      proxyUrl: 'http://orders:4000',
      listenPath: '/orders/',
      authType: 'NONE',
      status: 'ACTIVE',
      config: { rateLimit: { rate: 10, per: 1 } },
      defFormat: 'OAS',
      versionName: null,
      parentApiId: null,
      retiredAt: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };
    const planRow = {
      id: 'plan-1',
      name: 'Gold',
      description: null,
      rate: 10,
      per: 1,
      quotaMax: 1000,
      quotaPeriod: 'MONTHLY',
      active: true,
      requiresApproval: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };
    db.apiDefinition.findMany.mockResolvedValue([apiRow]);
    db.plan.findMany.mockResolvedValue([planRow]);
    db.product.findMany.mockResolvedValue([]);

    const first = await service.export(TENANT);
    const second = await service.export(TENANT);

    // Recursive key-sort before comparing, exactly as the live acceptance criterion specifies
    // (byte-identical is explicitly not the contract) — jest's toEqual is already a deep structural
    // comparison independent of key insertion order, so it exercises the same property.
    expect(second).toEqual(first);
  });

  it('never touches ApiKey, OAuthClient or AuditLog — secrets stay out by construction, not by a filter', async () => {
    // The mocked client declares ONLY these three models. A service that reached for
    // prisma.apiKey/oAuthClient/auditLog would call an undefined method and this would reject.
    db.apiDefinition.findMany.mockResolvedValue([]);
    db.plan.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([]);

    await expect(service.export(TENANT)).resolves.toEqual({ apis: [], plans: [], products: [] });
  });
});
