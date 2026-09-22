import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { UserPayload } from '../types';

/** A header can arrive repeated, in which case express hands back an array. */
const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Resolves the tenant every downstream query is scoped to and rejects anything it cannot resolve.
 *
 * Two rules, in this order:
 *  1. An `X-Tenant-ID` header must equal the tenant of the resolved session — you cannot ask for
 *     another tenant. Since WP2 the header is also what SELECTS the active tenant (JwtStrategy →
 *     AuthService#resolveSession honours it when the caller is a member of it, which is the tenant
 *     switcher), so a header that still disagrees here names a tenant the caller is not in.
 *  2. The caller must HAVE a tenant. A user with no membership — or one Keto did not confirm — has
 *     no `tenantId`; letting them through left `request.tenantId` undefined, Prisma dropped the
 *     `where: { tenantId: undefined }` filter and every tenant's rows came back.
 *
 * There is deliberately no super-admin short-circuit: the old `roles.includes('SUPER_ADMIN')` branch
 * returned before `request.tenantId` was ever set (and never matched, since roles are seeded
 * lowercase). Tenant resolution now runs for every role, super_admin included — a super_admin acts
 * in its own active tenant, which is also what keeps the session's roles/permissions/tenantId
 * aligned.
 */
@Injectable()
export class TenantIsolationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: UserPayload; tenantId?: string; headers: Record<string, string | string[] | undefined> }>();
    const user = request.user;

    if (!user) {
      // Let JwtAuthGuard handle the authentication failure.
      return true;
    }

    const headerTenantId = firstHeader(request.headers['x-tenant-id']);
    if (headerTenantId && headerTenantId !== user.tenantId) {
      throw new ForbiddenException(
        'Access denied: you do not have access to the requested tenant',
      );
    }

    if (!user.tenantId) {
      throw new ForbiddenException(
        'Access denied: your account is not assigned to a tenant',
      );
    }

    // Verified tenant for downstream use (@CurrentTenant, AuditLogInterceptor).
    request.tenantId = user.tenantId;

    return true;
  }
}
