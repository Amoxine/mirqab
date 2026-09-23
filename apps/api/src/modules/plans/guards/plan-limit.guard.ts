import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { TenantPlan } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { Request } from 'express';

/**
 * How many APIs each tenant tier may publish. `null` is unlimited.
 *
 * Config, not data: these are the product's own commercial tiers, the same for every deployment,
 * and a tenant admin must not be able to raise its own ceiling — which is exactly what a database
 * column would allow. Changing a tier is a release.
 */
export const API_LIMIT_BY_PLAN: Record<TenantPlan, number | null> = {
  [TenantPlan.FREE]: 3,
  [TenantPlan.STARTER]: 10,
  [TenantPlan.PRO]: 50,
  [TenantPlan.ENTERPRISE]: null,
};

/**
 * Enforces `Tenant.plan`'s API ceiling on creation (WP18, owner decision O7: hard block, not a
 * soft warning — a silently unenforced limit is the bug this replaces).
 *
 * A guard rather than a check inside `ApiService.create()` for two reasons. It is the same shape as
 * the permission guard already on that route — "may this caller do this at all", decided before any
 * work starts — and it keeps a commercial rule out of the service that every other caller of
 * `create()` shares, including the OAS importer, which gets the ceiling for free by sitting behind
 * the same route.
 *
 * **Only default/base APIs count.** A row with `parentApiId` set is a version of an existing API
 * (WP16), not a new one: counting versions would mean a FREE tenant hit its ceiling after one API
 * and two versions of it, which reads as a bug to the person who published them. The plan predates
 * WP16 and does not say; this is the reading, and it is asserted in the tests rather than implied.
 */
@Injectable()
export class PlanLimitGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { tenantId?: string }>();
    const tenantId = request.tenantId;

    // No tenant on the request means TenantIsolationGuard has not run or has rejected it. Not this
    // guard's job to decide that; let the request through to the one that owns the answer.
    if (!tenantId) return true;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });
    if (!tenant) return true;

    const limit = API_LIMIT_BY_PLAN[tenant.plan];
    if (limit === null) return true;

    const current = await prisma.apiDefinition.count({
      where: { tenantId, parentApiId: null },
    });

    if (current >= limit) {
      throw new ForbiddenException({
        message: `The ${tenant.plan} plan allows ${String(limit)} APIs; this tenant has ${String(current)}. Upgrade to add more.`,
        error: 'PLAN_LIMIT_EXCEEDED',
      });
    }
    return true;
  }
}
