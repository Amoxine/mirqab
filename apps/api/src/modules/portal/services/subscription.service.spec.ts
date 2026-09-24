import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { ApplicationService } from './application.service';
import { SubscriptionService } from './subscription.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' }) },
    product: { findFirst: jest.fn() },
    plan: { findFirst: jest.fn() },
    productApi: { findMany: jest.fn() },
    subscription: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    application: { findUnique: jest.fn() },
  },
}));

type Fn = jest.Mock;
const db = prisma as unknown as {
  product: { findFirst: Fn };
  plan: { findFirst: Fn };
  productApi: { findMany: Fn };
  subscription: { create: Fn; findMany: Fn; findUnique: Fn; update: Fn };
  application: { findUnique: Fn };
};

const DEVELOPER = 'dev-1';
const TENANT = 'tenant-1';
const APPLICATION = 'app-1';

function subRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    applicationId: APPLICATION,
    productId: 'product-1',
    planId: 'plan-1',
    status: 'PENDING',
    tykKeyId: null,
    keyHash: null,
    tykAclPolicyId: null,
    approvedAt: null,
    revokedAt: null,
    createdAt: new Date(0),
    product: { name: 'Payments Suite' },
    plan: { name: 'Gold' },
    ...overrides,
  };
}

function setup() {
  const tyk = {
    upsertPolicy: jest.fn().mockResolvedValue([]),
    createKey: jest.fn().mockResolvedValue({ keyHash: 'hash-1', key: 'raw-key-1' }),
    deleteKey: jest.fn().mockResolvedValue(undefined),
    deletePolicy: jest.fn().mockResolvedValue(undefined),
    getKey: jest.fn().mockResolvedValue({}),
  };
  const applications = { findRow: jest.fn().mockResolvedValue({ id: APPLICATION, developerId: DEVELOPER }) };
  return {
    tyk,
    applications,
    service: new SubscriptionService(
      tyk as unknown as TykClientService,
      applications as unknown as ApplicationService,
    ),
  };
}

describe('SubscriptionService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (prisma.tenant.findUniqueOrThrow as jest.Mock).mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' });
  });

  describe('create', () => {
    const dto = { productId: 'product-1', planId: 'plan-1' };

    it('auto-approves and issues a key when the plan does not require approval', async () => {
      const { service, tyk } = setup();
      db.product.findFirst.mockResolvedValue({ id: 'product-1', tenantId: TENANT });
      db.plan.findFirst.mockResolvedValue({ id: 'plan-1', tenantId: TENANT, active: true, requiresApproval: false });
      db.subscription.create.mockResolvedValue(subRow());
      db.productApi.findMany.mockResolvedValue([{ apiDef: { name: 'Orders', tykApiId: 'og-orders' } }]);
      db.subscription.update.mockResolvedValue(subRow({ status: 'APPROVED', tykKeyId: 'hash-1' }));

      const detail = await service.create(dto, APPLICATION, DEVELOPER, TENANT);

      expect(detail.status).toBe('APPROVED');
      expect(detail.keyValue).toBe('raw-key-1');
      expect(tyk.upsertPolicy).toHaveBeenCalled();
      expect(tyk.createKey).toHaveBeenCalled();
    });

    it('leaves the subscription PENDING with no key when the plan requires approval', async () => {
      const { service, tyk } = setup();
      db.product.findFirst.mockResolvedValue({ id: 'product-1', tenantId: TENANT });
      db.plan.findFirst.mockResolvedValue({ id: 'plan-1', tenantId: TENANT, active: true, requiresApproval: true });
      db.subscription.create.mockResolvedValue(subRow());

      const detail = await service.create(dto, APPLICATION, DEVELOPER, TENANT);

      expect(detail.status).toBe('PENDING');
      expect(detail.keyValue).toBeUndefined();
      expect(tyk.createKey).not.toHaveBeenCalled();
    });

    it('404s a product belonging to another tenant — the cross-tenant catalog guard', async () => {
      const { service } = setup();
      db.product.findFirst.mockResolvedValue(null); // scoped query already excludes another tenant's row

      await expect(service.create(dto, APPLICATION, DEVELOPER, TENANT)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a plan belonging to another tenant', async () => {
      const { service } = setup();
      db.product.findFirst.mockResolvedValue({ id: 'product-1', tenantId: TENANT });
      db.plan.findFirst.mockResolvedValue(null);

      await expect(service.create(dto, APPLICATION, DEVELOPER, TENANT)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400s an unpublished (inactive) plan', async () => {
      const { service } = setup();
      db.product.findFirst.mockResolvedValue({ id: 'product-1', tenantId: TENANT });
      db.plan.findFirst.mockResolvedValue({ id: 'plan-1', tenantId: TENANT, active: false, requiresApproval: false });

      await expect(service.create(dto, APPLICATION, DEVELOPER, TENANT)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.subscription.create).not.toHaveBeenCalled();
    });

    it('409s re-subscribing to the same product', async () => {
      const { service } = setup();
      db.product.findFirst.mockResolvedValue({ id: 'product-1', tenantId: TENANT });
      db.plan.findFirst.mockResolvedValue({ id: 'plan-1', tenantId: TENANT, active: true, requiresApproval: false });
      db.subscription.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.5.0',
          meta: { target: ['application_id', 'product_id'] },
        }),
      );

      await expect(service.create(dto, APPLICATION, DEVELOPER, TENANT)).rejects.toBeInstanceOf(ConflictException);
    });

    it('checks application ownership before anything else (cross-account 403)', async () => {
      const { service, applications } = setup();
      applications.findRow.mockRejectedValue(new ForbiddenException());

      await expect(service.create(dto, APPLICATION, DEVELOPER, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.product.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('tears down the gateway key and policy, then marks REVOKED', async () => {
      const { service, tyk } = setup();
      db.subscription.findUnique.mockResolvedValue(
        subRow({ status: 'APPROVED', tykKeyId: 'hash-1', tykAclPolicyId: 'acl-1' }),
      );
      db.application.findUnique.mockResolvedValue({ id: APPLICATION, developerId: DEVELOPER });
      db.subscription.update.mockResolvedValue(subRow({ status: 'REVOKED' }));

      const detail = await service.revoke('sub-1', DEVELOPER);

      expect(tyk.deleteKey).toHaveBeenCalledWith('hash-1');
      expect(tyk.deletePolicy).toHaveBeenCalledWith('acl-1');
      expect(detail.status).toBe('REVOKED');
    });

    it('403s revoking a subscription that belongs to a different account', async () => {
      const { service } = setup();
      db.subscription.findUnique.mockResolvedValue(subRow());
      db.application.findUnique.mockResolvedValue({ id: APPLICATION, developerId: 'someone-else' });

      await expect(service.revoke('sub-1', DEVELOPER)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to revoke an already-revoked subscription', async () => {
      const { service } = setup();
      db.subscription.findUnique.mockResolvedValue(subRow({ status: 'REVOKED' }));
      db.application.findUnique.mockResolvedValue({ id: APPLICATION, developerId: DEVELOPER });

      await expect(service.revoke('sub-1', DEVELOPER)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
