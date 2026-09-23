import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { TenantPlan } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { API_LIMIT_BY_PLAN, PlanLimitGuard } from './plan-limit.guard';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    tenant: { findUnique: jest.fn() },
    apiDefinition: { count: jest.fn() },
  },
}));

/* eslint-disable @typescript-eslint/unbound-method -- these are jest mocks, not methods being called */
const tenantFind = prisma.tenant.findUnique as unknown as jest.Mock;
const apiCount = prisma.apiDefinition.count as unknown as jest.Mock;
/* eslint-enable @typescript-eslint/unbound-method */

const ctx = (tenantId?: string): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ tenantId }) }) }) as unknown as ExecutionContext;

describe('PlanLimitGuard (WP18, O7 hard block)', () => {
  let guard: PlanLimitGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    guard = new PlanLimitGuard();
  });

  it('blocks a FREE tenant at its ceiling with code PLAN_LIMIT_EXCEEDED', async () => {
    tenantFind.mockResolvedValue({ plan: TenantPlan.FREE });
    apiCount.mockResolvedValue(API_LIMIT_BY_PLAN[TenantPlan.FREE]);

    const error = await guard.canActivate(ctx('t1')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ error: 'PLAN_LIMIT_EXCEEDED' });
  });

  it('allows a FREE tenant one below the ceiling', async () => {
    tenantFind.mockResolvedValue({ plan: TenantPlan.FREE });
    apiCount.mockResolvedValue((API_LIMIT_BY_PLAN[TenantPlan.FREE] ?? 0) - 1);

    await expect(guard.canActivate(ctx('t1'))).resolves.toBe(true);
  });

  it('never blocks ENTERPRISE, whose limit is unlimited', async () => {
    tenantFind.mockResolvedValue({ plan: TenantPlan.ENTERPRISE });
    apiCount.mockResolvedValue(10_000);

    await expect(guard.canActivate(ctx('t1'))).resolves.toBe(true);
    // Unlimited short-circuits before counting — no reason to scan the table.
    expect(apiCount).not.toHaveBeenCalled();
  });

  /**
   * The WP16 interaction the plan predates. A version is an ApiDefinition row with `parentApiId`
   * set; counting those would mean one API plus two versions exhausts a 3-API plan.
   */
  it('counts only default/base APIs, never versions', async () => {
    tenantFind.mockResolvedValue({ plan: TenantPlan.FREE });
    apiCount.mockResolvedValue(0);

    await guard.canActivate(ctx('t1'));

    expect(apiCount).toHaveBeenCalledWith({ where: { tenantId: 't1', parentApiId: null } });
  });

  it('defers to the tenant guard when the request carries no tenant', async () => {
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(true);
    expect(tenantFind).not.toHaveBeenCalled();
  });

  it('every tier has an explicit limit, so a new tier cannot default to unlimited by omission', () => {
    for (const plan of Object.values(TenantPlan)) {
      expect(API_LIMIT_BY_PLAN).toHaveProperty(plan);
    }
  });
});
