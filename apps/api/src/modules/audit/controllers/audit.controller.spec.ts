import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import type { UserPayload } from '../../../common/types';
import { AuditController } from './audit.controller';

/** A request context for `handler`, the way Nest hands one to a guard. */
function contextFor(handler: object, user: Pick<UserPayload, 'roles' | 'permissions'>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => AuditController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

// AC-LOG01.2: the SERVER-side gate on this route. The web suite covers the client-side hide of the
// "view traffic" action; that alone proves nothing about the API, which must refuse it independently.
describe('AuditController — GET traffic/:apiDefId route permission', () => {
  const handlerOf = (name: keyof AuditController): object =>
    Reflect.get(AuditController.prototype, name) as object;
  const traffic = handlerOf('findRelatedTraffic');
  const guard = new PermissionsGuard(new Reflector());

  it('requires analytics:read', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, traffic)).toEqual(['analytics:read']);
  });

  it('is behind PermissionsGuard (controller-level)', () => {
    expect(Reflect.getMetadata('__guards__', AuditController) as unknown[]).toContain(PermissionsGuard);
  });

  it('403s a caller without analytics:read, even one holding audit:read', () => {
    const run = () =>
      guard.canActivate(contextFor(traffic, { roles: ['viewer'], permissions: ['audit:read'] }));
    expect(run).toThrow(ForbiddenException);
    expect(run).toThrow('Missing permissions: analytics:read');
  });

  it('lets a caller holding analytics:read through to the service', () => {
    expect(
      guard.canActivate(contextFor(traffic, { roles: ['admin'], permissions: ['analytics:read'] })),
    ).toBe(true);
  });
});
