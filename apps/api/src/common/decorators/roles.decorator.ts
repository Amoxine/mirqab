import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'ROLES_METADATA';

/**
 * Decorator to specify which roles are allowed to access a route.
 * Used in conjunction with RolesGuard.
 *
 * @example
 * ```ts
 * @Roles('SUPER_ADMIN', 'ADMIN')
 * @Delete(':id')
 * removeUser(@Param('id') id: string) { ... }
 * ```
 *
 * @param roles - List of allowed roles (at least one must match)
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
