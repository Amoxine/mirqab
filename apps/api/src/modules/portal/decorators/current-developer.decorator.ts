import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { DeveloperPayload } from '../../../common/types';

/**
 * Extracts the authenticated developer from the request. Must be used on a route protected by
 * `DeveloperAuthGuard` — mirrors `@CurrentUser()`'s contract for the dashboard session.
 */
export const CurrentDeveloper = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DeveloperPayload => {
    return ctx.switchToHttp().getRequest<{ developer: DeveloperPayload }>().developer;
  },
);
