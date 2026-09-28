import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { AnalyticsRange } from '../../analytics/dto/analytics-query.dto';
import type { TrafficInspectorService } from '../../analytics/services/traffic-inspector.service';
import type { ApiService } from '../services/api.service';
import { ApiManagementController } from './api.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/** A route handler as the guard sees it (read off the prototype, never called unbound). */
const handler = (name: string): unknown =>
  (ApiManagementController.prototype as unknown as Record<string, unknown>)[name];

function contextAs(permissions: string[]): ExecutionContext {
  return {
    getHandler: () => handler('traffic'),
    getClass: () => ApiManagementController,
    switchToHttp: () => ({ getRequest: () => ({ user: { roles: ['operator'], permissions } }) }),
  } as unknown as ExecutionContext;
}

describe('GET /apis/:id/traffic (AC-LOG02.1)', () => {
  it('requires api:update, the same permission as /debug', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler('traffic') as object)).toEqual(['api:update']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler('debug') as object)).toEqual(['api:update']);
  });

  it('is enforced by PermissionsGuard on the whole controller', () => {
    expect(Reflect.getMetadata('__guards__', ApiManagementController)).toContain(PermissionsGuard);
  });

  it('answers 403 to a caller holding analytics:read but not api:update', () => {
    const guard = new PermissionsGuard(new Reflector());

    expect(() => guard.canActivate(contextAs(['analytics:read', 'api:read']))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextAs(['api:update']))).toBe(true);
  });

  it('hands the service the route id and the resolved tenant, never a Tyk id', async () => {
    const list = jest.fn().mockResolvedValue({ status: 'NOT_ENABLED' });
    const controller = new ApiManagementController(
      {} as ApiService,
      { list } as unknown as TrafficInspectorService,
    );

    const result = await controller.traffic('api-def-uuid', 'tenant-a', AnalyticsRange.SEVEN_DAYS, 2, 10);

    expect(list).toHaveBeenCalledWith('tenant-a', 'api-def-uuid', AnalyticsRange.SEVEN_DAYS, 2, 10);
    expect(result).toEqual({ success: true, data: { status: 'NOT_ENABLED' } });
  });
});
