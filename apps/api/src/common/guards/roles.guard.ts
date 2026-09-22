import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserPayload } from '../types';

/**
 * Guard that checks the authenticated user has at least one of the required roles.
 * Must be used after JwtAuthGuard (which sets request.user).
 *
 * Roles are compared case-insensitively: they are seeded lowercase into the free-form
 * `UserTenant.role` column, so a case-sensitive `includes()` matched nobody — `@Roles('ADMIN')`
 * locked out every user, super_admin included.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No roles specified — allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: UserPayload }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const hasRole = requiredRoles.some((required) =>
      user.roles.some((held) => held.toLowerCase() === required.toLowerCase()),
    );

    if (!hasRole) {
      throw new ForbiddenException(
        `Insufficient roles. Required one of: ${requiredRoles.join(', ')}. User has: ${user.roles.join(', ')}`,
      );
    }

    return true;
  }
}
