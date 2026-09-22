import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { TenantIsolationGuard } from './tenant-isolation.guard';
import type { UserPayload } from '../types';

interface FakeRequest {
  user?: Partial<UserPayload>;
  tenantId?: string;
  headers: Record<string, string | string[] | undefined>;
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const user = (roles: string[], tenantId?: string): Partial<UserPayload> =>
  ({ sub: 'u1', roles, tenantId }) as Partial<UserPayload>;

describe('TenantIsolationGuard', () => {
  const guard = new TenantIsolationGuard();

  it('defers to JwtAuthGuard when no user is attached', () => {
    const request: FakeRequest = { headers: {} };

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.tenantId).toBeUndefined();
  });

  // The old guard returned early for a super-admin, before request.tenantId was ever assigned — every
  // downstream query would then have been scoped to undefined.
  it.each([['viewer'], ['operator'], ['admin'], ['super_admin'], ['SUPER_ADMIN']])(
    'resolves the tenant for role %s',
    (role) => {
      const request: FakeRequest = { user: user([role], 't1'), headers: {} };

      expect(guard.canActivate(contextFor(request))).toBe(true);
      expect(request.tenantId).toBe('t1');
    },
  );

  it('rejects a caller with no tenant (a self-registered user) instead of scoping to undefined', () => {
    const request: FakeRequest = { user: user([]), headers: {} };

    expect(() => guard.canActivate(contextFor(request))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(request))).toThrow(
      'your account is not assigned to a tenant',
    );
    expect(request.tenantId).toBeUndefined();
  });

  it('rejects a tenant-less super_admin too — no role is exempt from having a tenant', () => {
    const request: FakeRequest = { user: user(['super_admin']), headers: {} };

    expect(() => guard.canActivate(contextFor(request))).toThrow(ForbiddenException);
  });

  it('rejects an X-Tenant-ID header that does not match the JWT claim', () => {
    const request: FakeRequest = { user: user(['admin'], 't1'), headers: { 'x-tenant-id': 't2' } };

    expect(() => guard.canActivate(contextFor(request))).toThrow(
      'you do not have access to the requested tenant',
    );
  });

  it('accepts a matching X-Tenant-ID header', () => {
    const request: FakeRequest = { user: user(['admin'], 't1'), headers: { 'x-tenant-id': 't1' } };

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.tenantId).toBe('t1');
  });

  it('reads only the first value of a repeated header', () => {
    const request: FakeRequest = {
      user: user(['admin'], 't1'),
      headers: { 'x-tenant-id': ['t2', 't1'] },
    };

    expect(() => guard.canActivate(contextFor(request))).toThrow(ForbiddenException);
  });
});
