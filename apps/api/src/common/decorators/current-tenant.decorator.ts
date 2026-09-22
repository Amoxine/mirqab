import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

/**
 * Extracts the tenant ID the request is scoped to.
 *
 * Source of truth, in order:
 *  1. `request.tenantId` — the value TenantIsolationGuard verified and copied onto the request.
 *  2. The JWT claim, for a route that runs without TenantIsolationGuard.
 *
 * The raw `X-Tenant-ID` header is deliberately NOT read here: it used to take precedence over the
 * verified claim, so any caller could scope a query to someone else's tenant by sending a header.
 * TenantIsolationGuard is the only place that header is honoured, and only after it matches the claim.
 *
 * @example
 * ```ts
 * @Get('resources')
 * findResources(@CurrentTenant() tenantId: string) { ... }
 * ```
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ tenantId?: string; user?: { tenantId?: string } }>();

    return request.tenantId ?? request.user?.tenantId;
  },
);
