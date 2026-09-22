import 'reflect-metadata';
import type { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import { ketoCheck } from '../../../common/ory/keto';
import type { UserPayload } from '../../../common/types';

// The Keto round trip is covered by the live checks in WP2's report; what matters here is that the
// session only carries a tenant Keto confirmed.
jest.mock('../../../common/ory/keto', () => ({
  ketoCheck: jest.fn(() => Promise.resolve(true)),
}));

const ketoCheckMock = ketoCheck as jest.MockedFunction<typeof ketoCheck>;

interface UserTenantRow {
  tenantId: string;
  role: string;
  isDefault: boolean;
  tenant: { name: string };
}

const row = (tenantId: string, name: string, isDefault: boolean, role = 'admin'): UserTenantRow => ({
  tenantId,
  role,
  isDefault,
  tenant: { name },
});

/** AuthService reads the shared prisma singleton, so the test swaps the field for its own doubles. */
function makeService(
  userTenants: UserTenantRow[],
  options: { status?: string; permissions?: string[]; user?: unknown } = {},
): AuthService {
  const service = new AuthService();

  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        'user' in options
          ? options.user
          : {
              id: 'u1',
              email: 'a@b.c',
              name: 'A B',
              status: options.status ?? 'ACTIVE',
              userTenants,
            },
      ),
    },
    role: {
      findUnique: jest.fn().mockResolvedValue({
        permissions: (options.permissions ?? []).map((name) => ({ permission: { name } })),
      }),
    },
  };
  // Test seam: `prisma` is a private field.
  (service as unknown as { prisma: PrismaClient }).prisma = prisma as unknown as PrismaClient;

  return service;
}

beforeEach(() => {
  ketoCheckMock.mockReset();
  ketoCheckMock.mockResolvedValue(true);
});

describe('AuthService.resolveSession', () => {
  it('scopes roles, permissions and tenantId to the default tenant', async () => {
    const session = await makeService([row('t1', 'Other', false, 'viewer'), row('t2', 'Acme', true)], {
      permissions: ['api:read'],
    }).resolveSession('u1');

    expect(session).toEqual({
      sub: 'u1',
      email: 'a@b.c',
      roles: ['admin'],
      tenantId: 't2',
      status: 'ACTIVE',
      permissions: ['api:read'],
    });
  });

  it('activates the tenant named by X-Tenant-ID when the caller is a member of it', async () => {
    const session = await makeService([row('t1', 'Other', false, 'viewer'), row('t2', 'Acme', true)])
      .resolveSession('u1', 't1');

    expect(session?.tenantId).toBe('t1');
    expect(session?.roles).toEqual(['viewer']);
  });

  it('falls back to the default tenant when X-Tenant-ID names one the caller is not in', async () => {
    // TenantIsolationGuard then 403s the header/session mismatch — this is the cross-tenant path.
    const session = await makeService([row('t2', 'Acme', true)]).resolveSession('u1', 'someone-else');

    expect(session?.tenantId).toBe('t2');
  });

  it('leaves the session tenant-less when Keto denies the membership', async () => {
    ketoCheckMock.mockResolvedValue(false);

    const session = await makeService([row('t2', 'Acme', true)], {
      permissions: ['api:read'],
    }).resolveSession('u1');

    expect(session?.tenantId).toBeUndefined();
    expect(session?.roles).toEqual([]);
    expect(session?.permissions).toEqual([]);
  });

  it('checks the ACTIVE tenant against Keto, not some other membership', async () => {
    await makeService([row('t1', 'Other', false), row('t2', 'Acme', true)]).resolveSession('u1');

    expect(ketoCheckMock).toHaveBeenCalledWith('t2', 'view', 'u1');
    expect(ketoCheckMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for a suspended account, so the token stops working immediately', async () => {
    const session = await makeService([row('t2', 'Acme', true)], { status: 'SUSPENDED' })
      .resolveSession('u1');

    expect(session).toBeNull();
    expect(ketoCheckMock).not.toHaveBeenCalled();
  });

  it('returns null for a subject with no user row (e.g. a data-plane client token)', async () => {
    const session = await makeService([], { user: null }).resolveSession('some-oauth2-client-id');

    expect(session).toBeNull();
  });

  it('gives a user with no membership no tenant and no permissions', async () => {
    const session = await makeService([]).resolveSession('u1');

    expect(session?.tenantId).toBeUndefined();
    expect(session?.permissions).toEqual([]);
    expect(ketoCheckMock).not.toHaveBeenCalled();
  });
});

describe('AuthService.getCurrentUser', () => {
  const session = (tenantId?: string): UserPayload => ({
    sub: 'u1',
    email: 'a@b.c',
    roles: ['admin'],
    ...(tenantId !== undefined && { tenantId }),
    status: 'ACTIVE',
    permissions: ['api:read'],
  });

  it('names the ACTIVE tenant, and lists every membership for the switcher', async () => {
    const me = await makeService([row('t1', 'Other', false), row('t2', 'Acme', true)])
      .getCurrentUser(session('t1'));

    expect(me.tenantName).toBe('Other');
    expect(me.tenants).toEqual([
      { tenantId: 't1', role: 'admin', name: 'Other' },
      { tenantId: 't2', role: 'admin', name: 'Acme' },
    ]);
    expect(me).toMatchObject({ id: 'u1', email: 'a@b.c', name: 'A B', permissions: ['api:read'] });
  });

  it('reports no tenant name when the session has no active tenant', async () => {
    const me = await makeService([row('t2', 'Acme', true)]).getCurrentUser(session());

    expect(me.tenantName).toBeNull();
  });
});
