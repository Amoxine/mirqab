import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'PERMISSIONS_METADATA';

/**
 * Decorator to specify required permissions for a route.
 * Permissions use "resource:action" format.
 * Used in conjunction with PermissionsGuard.
 *
 * @example
 * ```ts
 * @Permissions('apis:write', 'keys:write')
 * @Post('apis')
 * createApi(@Body() dto: CreateApiDto) { ... }
 * ```
 *
 * @param permissions - List of required permissions (ALL must match)
 */
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
