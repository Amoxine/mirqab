import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import type { UserPayload } from '../../../common/types';
import type { AuditService } from '../services/audit.service';
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

// GET :id used to answer 200 with an empty body for an id that does not exist (or belongs to another
// tenant: the tenant-scoped lookup finds nothing either way), which a client cannot tell from an
// entry with no content. Both are a 404, and the same one, so the answer leaks nothing about other tenants.
describe('AuditController.findOne', () => {
  const controllerWith = (found: unknown) => {
    const findOne = jest.fn((_id: bigint, _tenantId: string | undefined) => Promise.resolve(found));
    return { controller: new AuditController({ findOne } as unknown as AuditService), findOne };
  };

  it('404s an entry that does not exist for the caller (missing, or another tenant’s)', async () => {
    const { controller, findOne } = controllerWith(null);
    await expect(controller.findOne('tenant-1', 17)).rejects.toThrow(NotFoundException);
    // It asked for exactly that tenant's entry.
    expect(findOne).toHaveBeenCalledWith(17n, 'tenant-1');
  });

  it('returns the entry when there is one', async () => {
    const entry = { id: 17n, action: 'UPDATED' };
    const { controller } = controllerWith(entry);
    await expect(controller.findOne('tenant-1', 17)).resolves.toBe(entry);
  });
});
