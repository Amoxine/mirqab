import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { authzDeniedTotal } from '../metrics/ops-metrics';
import { isSuperAdmin, UserPayload } from '../types';

/**
 * Guard that checks the authenticated user has ALL required permissions.
 * Permissions use "resource:action" format (e.g. "apis:write", "users:read").
 * Must be used after JwtAuthGuard (which sets request.user).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No permissions specified — allow access
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: UserPayload }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const userPermissions = user.permissions ?? [];

    // super_admin bypasses permission checks — but only inside its ACTIVE tenant: the session's
    // roles are scoped to the same tenant as its permissions and tenantId, so being super_admin of
    // tenant B no longer waves the caller through tenant A (see AuthService#resolveSession, which
    // fills both from the one tenant Keto confirmed).
    if (isSuperAdmin(user.roles)) {
      return true;
    }

    const missingPermissions = requiredPermissions.filter(
      (perm: string) => !userPermissions.includes(perm),
    );

    if (missingPermissions.length > 0) {
      authzDeniedTotal.inc({ reason: 'missing_permission' });
      throw new ForbiddenException(
        `Missing permissions: ${missingPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
