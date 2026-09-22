import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { UserPayload } from '../types';

/**
 * Extracts the authenticated user payload from the request.
 * Must be used on routes protected by JwtAuthGuard.
 *
 * @example
 * ```ts
 * @Get('me')
 * getProfile(@CurrentUser() user: UserPayload) {
 *   return user;
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserPayload => {
    return ctx.switchToHttp().getRequest<{ user: UserPayload }>().user;
  },
);
