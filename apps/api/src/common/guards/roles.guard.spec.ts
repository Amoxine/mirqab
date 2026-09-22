import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/** A route handler carrying the metadata `@Roles(...roles)` would attach. */
function handlerRequiring(...roles: string[]): () => string {
  const handler = () => 'ok';
  if (roles.length > 0) Reflect.defineMetadata(ROLES_KEY, roles, handler);
  return handler;
}

const open = handlerRequiring();
const adminOnly = handlerRequiring('SUPER_ADMIN', 'ADMIN');

function contextFor(handler: () => string, roles?: string[]): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({ user: roles ? { roles } : undefined }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows a route without @Roles()', () => {
    expect(guard.canActivate(contextFor(open, ['viewer']))).toBe(true);
  });

  // Roles are seeded lowercase, so the previous case-sensitive includes() matched nobody:
  // @Roles('SUPER_ADMIN', 'ADMIN') locked every user out of creating or archiving a tenant.
  it.each([['super_admin'], ['admin'], ['ADMIN'], ['Admin']])(
    'matches the required role case-insensitively for %s',
    (role) => {
      expect(guard.canActivate(contextFor(adminOnly, [role]))).toBe(true);
    },
  );

  it('still rejects a role that is not listed', () => {
    const run = () => guard.canActivate(contextFor(adminOnly, ['viewer']));

    expect(run).toThrow(ForbiddenException);
    expect(run).toThrow('Insufficient roles');
  });

  it('throws 403 when no user is attached to the request', () => {
    expect(() => guard.canActivate(contextFor(adminOnly))).toThrow('Authentication required');
  });
});
