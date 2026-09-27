import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { authzDeniedTotal } from '../metrics/ops-metrics';
import { PermissionsGuard } from './permissions.guard';

/** A route handler carrying the metadata that `@Permissions(...perms)` would attach. */
function handlerRequiring(...perms: string[]): () => string {
  const handler = () => 'ok';
  if (perms.length > 0) Reflect.defineMetadata(PERMISSIONS_KEY, perms, handler);
  return handler;
}

const open = handlerRequiring();
const guarded = handlerRequiring('api:read');
const guardedTwo = handlerRequiring('api:read', 'api:update');

/** Build a request context; the user is a plain claims object (roles are stored lowercase in the DB). */
function contextFor(handler: () => string, user?: { roles: string[]; permissions?: string[] }): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());

  it('allows a route without @Permissions()', () => {
    expect(guard.canActivate(contextFor(open, { roles: ['viewer'], permissions: [] }))).toBe(true);
  });

  it('lets a lowercase super_admin role bypass the permission check', () => {
    expect(guard.canActivate(contextFor(guarded, { roles: ['super_admin'], permissions: [] }))).toBe(true);
  });

  it('lets an uppercase SUPER_ADMIN role bypass the permission check', () => {
    expect(guard.canActivate(contextFor(guarded, { roles: ['SUPER_ADMIN'], permissions: [] }))).toBe(true);
  });

  it('allows a user holding the required permission', () => {
    expect(guard.canActivate(contextFor(guarded, { roles: ['operator'], permissions: ['api:read'] }))).toBe(true);
  });

  it('throws 403 naming the missing permission', () => {
    const run = () => guard.canActivate(contextFor(guarded, { roles: ['viewer'], permissions: ['key:read'] }));
    expect(run).toThrow(ForbiddenException);
    expect(run).toThrow('Missing permissions: api:read');
  });

  it('requires ALL listed permissions', () => {
    const run = () => guard.canActivate(contextFor(guardedTwo, { roles: ['viewer'], permissions: ['api:read'] }));
    expect(run).toThrow('Missing permissions: api:update');
  });

  it('treats a stale token without a permissions claim as having none', () => {
    expect(() => guard.canActivate(contextFor(guarded, { roles: ['operator'] }))).toThrow(ForbiddenException);
  });

  it('throws 403 when no user is attached to the request', () => {
    expect(() => guard.canActivate(contextFor(guarded))).toThrow(ForbiddenException);
  });

  it('counts a missing-permission denial as og_authz_denied_total{reason="missing_permission"} only (APP-07)', async () => {
    authzDeniedTotal.reset();
    expect(() => guard.canActivate(contextFor(guarded, { roles: ['viewer'], permissions: [] }))).toThrow(ForbiddenException);
    guard.canActivate(contextFor(guarded, { roles: ['operator'], permissions: ['api:read'] }));

    const { values } = await authzDeniedTotal.get();
    expect(values).toEqual([{ labels: { reason: 'missing_permission' }, value: 1 }]);
  });
});
