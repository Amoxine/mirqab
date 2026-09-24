import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import 'reflect-metadata';
import { TenantService } from './tenant.service';
import type { OrgQuotaService } from '../../quotas/services/org-quota.service';
import type { UserPayload } from '../../../common/types';
import { ketoCheck, ketoDeleteMembership, ketoWriteMembership } from '../../../common/ory/keto';
import type * as KetoModule from '../../../common/ory/keto';

// TenantService talks to Keto over the network on every `:id` route (WP2/WP6/WP7-FIX). Only the
// network calls are mocked here, not `relationForRole` (a pure function this suite's role-change
// specs need to behave for real) — an auto-mock of the whole module replaces every export,
// `relationForRole` included, with a jest.fn() returning `undefined`.
jest.mock('../../../common/ory/keto', () => ({
  ...jest.requireActual<typeof KetoModule>('../../../common/ory/keto'),
  ketoCheck: jest.fn(),
  ketoWriteMembership: jest.fn(),
  ketoDeleteMembership: jest.fn(),
}));

// The mocks above are shared module-level instances (the module is loaded once for the whole file)
// — reset call history AND any per-test mockImplementation between tests so one spec can't leak
// into the next.
afterEach(() => {
  jest.resetAllMocks();
});

// Default for every spec that isn't about authorization: Keto grants whatever is asked. The specs
// that ARE about it override this. Must run after the reset above, hence beforeEach.
beforeEach(() => {
  jest.mocked(ketoCheck).mockResolvedValue(true);
});

const tenantRow = {
  id: 't1',
  name: 'Acme',
  slug: 'acme',
  plan: 'FREE',
  status: 'ACTIVE',
  config: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

/** The shape of the Prisma args this suite asserts on. */
interface QueryArgs {
  where: Record<string, unknown>;
}

/** All 38 seeded permissions (packages/database/prisma/permissions.ts), narrowed to what the
 * role-seeding predicates read. It went stale at WP18 (26 -> 35 without this list following), which
 * is how `operator` came to be created without `plan:read`/`product:read` unnoticed until WP26a. */
const permissionRow = (name: string) => ({ id: `perm-${name}`, name, resource: name.split(':')[0], action: name.split(':')[1] });
const ALL_PERMISSIONS = [
  'api:read', 'api:create', 'api:update', 'api:delete', 'api:sync',
  'key:read', 'key:create', 'key:update', 'key:revoke',
  'tenant:read', 'tenant:create', 'tenant:update', 'tenant:delete',
  'user:read', 'user:create', 'user:update', 'user:delete',
  'role:read', 'role:create', 'role:update', 'role:delete',
  'analytics:read', 'analytics:export',
  'audit:read', 'audit:export',
  'settings:read', 'settings:update',
  'plan:read', 'plan:create', 'plan:update', 'plan:delete',
  'product:read', 'product:create', 'product:update', 'product:delete',
  'cert:read', 'cert:create', 'cert:delete',
].map(permissionRow);

/** Captures what TenantService asks Prisma for, so the scoping itself can be asserted. */
function makeService(options: {
  member?: boolean;
  tenants?: unknown[];
  existingSlug?: boolean;
  /** All UserTenant rows in the tenant, for isLastAdmin's findMany (role-change/remove-member specs). */
  members?: { userId: string; role: string }[];
  /** Role of a non-caller (target) user, keyed by userId, for updateMemberRole/removeMember's own
   * findUnique lookup — the caller ('u1') is controlled by `member` above instead. */
  memberRoles?: Record<string, string>;
  /** `prisma.user.findUnique` result for lookupUserByEmail specs; `undefined` (key absent) keeps the default match. */
  userByEmail?: { id: string; email: string; name: string } | null;
} = {}) {
  const userTenantFindUnique = jest.fn((args: QueryArgs) => {
    const uid = (args.where.userId_tenantId as { userId?: string } | undefined)?.userId;
    if (uid === 'u1') {
      // assertPermit's own check on the caller. `role` only matters when the caller is ALSO the
      // target of a role change — the self-promotion case.
      return Promise.resolve(
        options.member === false
          ? null
          : { userId: 'u1', role: options.memberRoles?.u1 ?? 'viewer' },
      );
    }
    const role = options.memberRoles?.[uid ?? ''];
    return Promise.resolve(role !== undefined ? { userId: uid, role } : null);
  });
  const tenantFindMany = jest.fn((_args: QueryArgs) => Promise.resolve(options.tenants ?? [tenantRow]));
  const tenantCount = jest.fn((_args: QueryArgs) => Promise.resolve(1));
  // Two unrelated call sites share this mock: findOne/update/archive/findUsers look up by `id` (must
  // find the row), create()'s uniqueness check looks up by `slug` (must NOT find one, by default).
  const tenantFindUnique = jest.fn((args: QueryArgs) =>
    Promise.resolve('slug' in args.where ? (options.existingSlug ? tenantRow : null) : tenantRow),
  );
  const tenantUpdate = jest.fn().mockResolvedValue(tenantRow);
  const tenantCreate = jest.fn().mockResolvedValue(tenantRow);
  const tenantDelete = jest.fn().mockResolvedValue(tenantRow);
  const userTenantFindMany = jest.fn().mockResolvedValue(options.members ?? []);
  const userTenantCreate = jest.fn().mockResolvedValue({});
  const userTenantUpdate = jest.fn((args: { data: { role: string } }) =>
    Promise.resolve({
      userId: 'u2',
      role: args.data.role,
      isDefault: false,
      createdAt: tenantRow.createdAt,
      user: { id: 'u2', email: 'member@b.c', name: 'Member' },
    }),
  );
  const userTenantDelete = jest.fn().mockResolvedValue({});
  const userFindUnique = jest.fn(() =>
    Promise.resolve(
      'userByEmail' in options ? options.userByEmail : { id: 'u2', email: 'member@b.c', name: 'Member' },
    ),
  );
  const permissionFindMany = jest.fn().mockResolvedValue(ALL_PERMISSIONS);
  const roleCreate = jest.fn((args: { data: { name: string; tenantId: string } }) =>
    Promise.resolve({ id: `role-${args.data.name}`, ...args.data }),
  );
  const rolePermissionCreateMany = jest.fn((_args: { data: { roleId: string; permissionId: string }[] }) =>
    Promise.resolve({ count: _args.data.length }),
  );

  // None of these tests exercise the WP19 quota routes — a stub is enough to satisfy the constructor.
  const orgQuota = { get: jest.fn(), set: jest.fn(), reset: jest.fn(), resetKey: jest.fn() };
  const service = new TenantService(orgQuota as unknown as OrgQuotaService);
  const prisma: Record<string, unknown> = {
    tenant: {
      findMany: tenantFindMany,
      count: tenantCount,
      findUnique: tenantFindUnique,
      update: tenantUpdate,
      create: tenantCreate,
      delete: tenantDelete,
    },
    userTenant: {
      findUnique: userTenantFindUnique,
      findMany: userTenantFindMany,
      create: userTenantCreate,
      update: userTenantUpdate,
      delete: userTenantDelete,
    },
    user: { findUnique: userFindUnique },
    permission: { findMany: permissionFindMany },
    role: { create: roleCreate },
    rolePermission: { createMany: rolePermissionCreateMany },
  };
  // findAll runs its two reads as a sequential-array transaction; create() runs an interactive
  // (callback) one — Prisma's $transaction supports both shapes, so the fake does too. Defined after
  // the literal above (not inside it) so it can reference `prisma` without a self-referential type.
  prisma.$transaction = jest.fn((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
  (service as unknown as { prisma: unknown }).prisma = prisma;

  return {
    service,
    tenantFindMany,
    tenantCount,
    tenantCreate,
    tenantUpdate,
    tenantDelete,
    userTenantFindUnique,
    userTenantFindMany,
    userTenantCreate,
    userTenantUpdate,
    userTenantDelete,
    userFindUnique,
    permissionFindMany,
    roleCreate,
    rolePermissionCreateMany,
  };
}

const caller = (roles: string[]): UserPayload =>
  ({ sub: 'u1', email: 'a@b.c', roles, tenantId: 't1', status: 'ACTIVE' }) as UserPayload;

// A4: these routes had no scoping at all — GET /tenants listed every organisation on the installation
// and GET /tenants/:id/users leaked their members' email addresses to any authenticated user.
describe('TenantService.findAll scoping', () => {
  it('restricts the list to tenants the caller is a member of', async () => {
    const { service, tenantFindMany, tenantCount } = makeService();

    await service.findAll({ page: 1, pageSize: 20 }, caller(['admin']));

    const expected = { userTenants: { some: { userId: 'u1' } } };
    expect(tenantFindMany.mock.calls[0][0].where).toEqual(expected);
    // The count must carry the same filter, or the pager reports other people's tenants.
    expect(tenantCount.mock.calls[0][0].where).toEqual(expected);
  });

  it.each([['super_admin'], ['SUPER_ADMIN']])('lets %s see every tenant', async (role) => {
    const { service, tenantFindMany } = makeService();

    await service.findAll({ page: 1, pageSize: 20 }, caller([role]));

    expect(tenantFindMany.mock.calls[0][0].where).toEqual({});
  });
});

describe('TenantService membership checks', () => {
  const nonMember = { member: false };

  it.each([
    ['findOne', (s: TenantService, u: UserPayload) => s.findOne('t9', u)],
    ['findUsers', (s: TenantService, u: UserPayload) => s.findUsers('t9', u)],
    ['update', (s: TenantService, u: UserPayload) => s.update('t9', { name: 'x' }, u)],
    ['archive', (s: TenantService, u: UserPayload) => s.archive('t9', u)],
    ['assignUser', (s: TenantService, u: UserPayload) => s.assignUser('t9', 'u2', 'viewer', u)],
    ['lookupUserByEmail', (s: TenantService, u: UserPayload) => s.lookupUserByEmail('t9', 'a@b.c', u)],
    ['updateMemberRole', (s: TenantService, u: UserPayload) => s.updateMemberRole('t9', 'u2', 'viewer', u)],
    ['removeMember', (s: TenantService, u: UserPayload) => s.removeMember('t9', 'u2', u)],
  ])('%s rejects a caller with no membership in that tenant', async (_name, call) => {
    const { service } = makeService(nonMember);

    await expect(call(service, caller(['admin']))).rejects.toThrow(ForbiddenException);
  });

  it.each([
    ['findOne', (s: TenantService, u: UserPayload) => s.findOne('t9', u)],
    ['findUsers', (s: TenantService, u: UserPayload) => s.findUsers('t9', u)],
  ])('%s allows super_admin without a membership row', async (_name, call) => {
    const { service, userTenantFindUnique } = makeService(nonMember);

    await expect(call(service, caller(['super_admin']))).resolves.toBeDefined();
    expect(userTenantFindUnique).not.toHaveBeenCalled();
  });

  it('allows a member through and checks the tenant actually asked for', async () => {
    const { service, userTenantFindUnique } = makeService();

    await service.findOne('t1', caller(['viewer']));

    expect(userTenantFindUnique.mock.calls[0][0].where).toEqual({
      userId_tenantId: { userId: 'u1', tenantId: 't1' },
    });
  });
});

// WP7-FIX (BLOCKER). A Postgres membership row was the ONLY thing between a caller and a tenant they
// merely belong to: PermissionsGuard answers "do you hold user:update?" from the session, whose
// permissions come from the caller's ACTIVE tenant (AuthService#resolveSession), not from the `:id`
// in the path. So an admin of tenant A who is a viewer-member of tenant B passed both gates and
// could `PATCH /tenants/B/users/<self> {"role":"admin"}` — self-promotion, no header forgery needed.
// The fix asks Keto about the tenant actually being acted on: `manage` for writes, `view` for reads.
describe('TenantService cross-tenant escalation', () => {
  /** The caller's session is tenant A's ('admin'); in the tenant being acted on they are a member
   * (Keto grants `view`) but not an admin (Keto denies `manage`). */
  const adminOfAnotherTenant = () => {
    jest
      .mocked(ketoCheck)
      .mockImplementation((_tenantId, permit) => Promise.resolve(permit === 'view'));
    return makeService({ memberRoles: { u2: 'viewer' } });
  };

  it.each([
    ['update', (s: TenantService, u: UserPayload) => s.update('t2', { name: 'pwned' }, u)],
    ['archive', (s: TenantService, u: UserPayload) => s.archive('t2', u)],
    ['assignUser', (s: TenantService, u: UserPayload) => s.assignUser('t2', 'u3', 'admin', u)],
    ['updateMemberRole', (s: TenantService, u: UserPayload) => s.updateMemberRole('t2', 'u1', 'admin', u)],
    ['removeMember', (s: TenantService, u: UserPayload) => s.removeMember('t2', 'u2', u)],
  ])('%s refuses a member Keto does not grant manage on the target tenant', async (_name, call) => {
    const { service, tenantUpdate, userTenantCreate, userTenantUpdate, userTenantDelete } =
      adminOfAnotherTenant();

    await expect(call(service, caller(['admin']))).rejects.toThrow(ForbiddenException);

    expect(ketoCheck).toHaveBeenCalledWith('t2', 'manage', 'u1');
    // Nothing was written on the way to the refusal.
    for (const write of [tenantUpdate, userTenantCreate, userTenantUpdate, userTenantDelete]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['findOne', (s: TenantService, u: UserPayload) => s.findOne('t2', u)],
    ['findUsers', (s: TenantService, u: UserPayload) => s.findUsers('t2', u)],
    ['lookupUserByEmail', (s: TenantService, u: UserPayload) => s.lookupUserByEmail('t2', 'a@b.c', u)],
  ])('%s still allows that same member, who does hold view', async (_name, call) => {
    const { service } = adminOfAnotherTenant();

    await expect(call(service, caller(['admin']))).resolves.toBeDefined();
    expect(ketoCheck).toHaveBeenCalledWith('t2', 'view', 'u1');
  });

  it.each([
    ['findOne', (s: TenantService, u: UserPayload) => s.findOne('t2', u)],
    ['findUsers', (s: TenantService, u: UserPayload) => s.findUsers('t2', u)],
  ])('%s refuses when Keto denies view, even with a membership row', async (_name, call) => {
    jest.mocked(ketoCheck).mockResolvedValue(false);
    const { service } = makeService();

    await expect(call(service, caller(['admin']))).rejects.toThrow(ForbiddenException);
  });

  it('propagates an unreachable Keto instead of silently allowing the write', async () => {
    jest.mocked(ketoCheck).mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, tenantUpdate } = makeService();

    await expect(service.update('t2', { name: 'x' }, caller(['admin']))).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(tenantUpdate).not.toHaveBeenCalled();
  });

  it('keeps the super_admin bypass, without asking Keto', async () => {
    jest.mocked(ketoCheck).mockResolvedValue(false);
    const { service } = makeService({ member: false });

    await expect(service.findOne('t2', caller(['super_admin']))).resolves.toBeDefined();
    expect(ketoCheck).not.toHaveBeenCalled();
  });
});

// WP0: a brand-new tenant used to get a UserTenant row (role: 'admin') but no matching Role row, so
// AuthService#loadPermissions found nothing and the creator's token carried zero permissions.
describe('TenantService.create default roles', () => {
  it("seeds admin, operator and viewer roles for the new tenant — but never super_admin", async () => {
    const { service, roleCreate, permissionFindMany } = makeService();

    await service.create({ name: 'Acme', slug: 'acme' }, caller(['super_admin']));

    expect(permissionFindMany).toHaveBeenCalledTimes(1);
    const seededRoles = roleCreate.mock.calls.map((call) => call[0].data.name);
    expect(seededRoles.sort()).toEqual(['admin', 'operator', 'viewer']);
    expect(roleCreate.mock.calls.every((call) => call[0].data.tenantId === tenantRow.id)).toBe(true);
  });

  it('grants the admin role everything except tenant:delete and role:delete', async () => {
    const { service, rolePermissionCreateMany } = makeService();

    await service.create({ name: 'Acme', slug: 'acme' }, caller(['super_admin']));

    // The fake role.create() below derives a deterministic id ("role-<name>") from its input.
    const adminGrant = rolePermissionCreateMany.mock.calls.find(([{ data }]) =>
      data.some((row) => row.roleId === 'role-admin'),
    );
    const grantedPermissionIds = adminGrant?.[0].data.map((row) => row.permissionId) ?? [];
    expect(grantedPermissionIds).toContain('perm-api:create');
    expect(grantedPermissionIds).not.toContain('perm-tenant:delete');
    expect(grantedPermissionIds).not.toContain('perm-role:delete');
  });

  it('grants the viewer role only read/export permissions', async () => {
    const { service, rolePermissionCreateMany } = makeService();

    await service.create({ name: 'Acme', slug: 'acme' }, caller(['super_admin']));

    const viewerGrant = rolePermissionCreateMany.mock.calls.find(([{ data }]) =>
      data.some((row) => row.roleId === 'role-viewer'),
    );
    const grantedPermissionIds = viewerGrant?.[0].data.map((row) => row.permissionId) ?? [];
    expect(grantedPermissionIds).toContain('perm-api:read');
    expect(grantedPermissionIds).toContain('perm-analytics:export');
    expect(grantedPermissionIds).not.toContain('perm-api:create');
    // The predicate auto-grants every new *:read — including WP26a's, and it must not leak a write.
    expect(grantedPermissionIds).toContain('perm-cert:read');
    expect(grantedPermissionIds).not.toContain('perm-cert:create');
    expect(grantedPermissionIds).not.toContain('perm-cert:delete');
  });

  // `operator` is the one EXPLICIT list (DoD-OWNER 1), so a new permission reaches it only by being
  // named — and this list is "kept in sync by hand" with seed.ts's. That contract silently broke at
  // WP19 (plan:read/product:read named in seed.ts but not here), so pin what operator gets from each
  // resource family added since the list was written.
  it('grants operator read-only on plans, products and certificates — and nothing that writes them', async () => {
    const { service, rolePermissionCreateMany } = makeService();

    await service.create({ name: 'Acme', slug: 'acme' }, caller(['super_admin']));

    const operatorGrant = rolePermissionCreateMany.mock.calls.find(([{ data }]) =>
      data.some((row) => row.roleId === 'role-operator'),
    );
    const granted = operatorGrant?.[0].data.map((row) => row.permissionId) ?? [];
    for (const name of ['plan:read', 'product:read', 'cert:read']) {
      expect(granted).toContain(`perm-${name}`);
    }
    for (const family of ['plan', 'product', 'cert']) {
      expect(granted.filter((id) => id.startsWith(`perm-${family}:`) && !id.endsWith(':read'))).toEqual([]);
    }
  });
});

// WP7-FIX (MAJOR). The Keto tuple is written after the Postgres transaction commits (two stores, one
// of which has no share in the other's transaction). With no compensation, a Keto outage left rows
// that Keto denies AND that block their own retry — the slug/"already assigned" conflicts below.
describe('TenantService Keto write compensation', () => {
  it('deletes the tenant it just created when the membership tuple cannot be written', async () => {
    jest.mocked(ketoWriteMembership).mockRejectedValue(new Error('keto down'));
    const { service, tenantDelete } = makeService();

    await expect(
      service.create({ name: 'Acme', slug: 'acme' }, caller(['super_admin'])),
    ).rejects.toThrow(BadGatewayException);

    // Without this the creator owns a tenant Keto locks them out of, and re-creating it is a 409.
    expect(tenantDelete).toHaveBeenCalledWith({ where: { id: tenantRow.id } });
  });

  it('deletes the membership row it just created when the tuple cannot be written', async () => {
    jest.mocked(ketoWriteMembership).mockRejectedValue(new Error('keto down'));
    const { service, userTenantDelete } = makeService();

    await expect(
      service.assignUser('t1', 'u2', 'viewer', caller(['admin'])),
    ).rejects.toThrow(BadGatewayException);

    expect(userTenantDelete).toHaveBeenCalledWith({
      where: { userId_tenantId: { userId: 'u2', tenantId: 't1' } },
    });
  });
});

// WP19: the same escalation gap as updateMemberRole's guard below, on the other path that writes
// `UserTenant.role` — inviting a brand new member straight in as "super_admin".
describe('TenantService.assignUser escalation guard', () => {
  it('403s an attempt to invite a member in as super_admin, before touching Keto or Postgres', async () => {
    const { service, userTenantCreate } = makeService();

    await expect(
      service.assignUser('t1', 'u2', 'super_admin', caller(['admin'])),
    ).rejects.toThrow(ForbiddenException);

    expect(ketoWriteMembership).not.toHaveBeenCalled();
    expect(userTenantCreate).not.toHaveBeenCalled();
  });
});

// WP6: worker-4/WP2 flagged and deliberately left this gap — a role change or removal wrote/deleted
// the Postgres UserTenant row but never touched the matching Keto tuple, so the OLD relation kept
// granting access (e.g. demoting admin -> viewer without deleting the `admin` tuple left `manage`
// active). These specs are the regression check for the fix.
describe('TenantService.updateMemberRole', () => {
  it('rejects when the target is not a member of the tenant', async () => {
    const { service } = makeService();

    await expect(
      service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin'])),
    ).rejects.toThrow(NotFoundException);
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
    expect(ketoWriteMembership).not.toHaveBeenCalled();
  });

  // WP19: `UserTenant.role` is matched by plain string against `Role.name`, and `isSuperAdmin`
  // matches that string globally with no tenant scoping — a tenant admin (who already clears
  // `assertPermit(..., 'manage')` in their own tenant) could otherwise self-grant the platform-wide
  // bypass with no header forgery. Rejected before the membership lookup, case-insensitively.
  it('403s an attempt to grant super_admin, before touching Keto or the membership row', async () => {
    const { service, userTenantUpdate } = makeService({ memberRoles: { u2: 'viewer' } });

    await expect(
      service.updateMemberRole('t1', 'u2', 'super_admin', caller(['admin'])),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.updateMemberRole('t1', 'u2', 'SUPER_ADMIN', caller(['admin'])),
    ).rejects.toThrow(ForbiddenException);
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
    expect(ketoWriteMembership).not.toHaveBeenCalled();
    expect(userTenantUpdate).not.toHaveBeenCalled();
  });

  it('skips Keto entirely when the coarse relation is unchanged (operator -> viewer are both "member")', async () => {
    const { service } = makeService({ memberRoles: { u2: 'operator' } });

    await service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin']));

    expect(ketoDeleteMembership).not.toHaveBeenCalled();
    expect(ketoWriteMembership).not.toHaveBeenCalled();
  });

  it('deletes the old tuple before writing the new one when the relation changes', async () => {
    const order: string[] = [];
    jest.mocked(ketoDeleteMembership).mockImplementation(() => {
      order.push('delete');
      return Promise.resolve();
    });
    jest.mocked(ketoWriteMembership).mockImplementation(() => {
      order.push('write');
      return Promise.resolve();
    });
    const { service } = makeService({
      memberRoles: { u2: 'viewer' },
      members: [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'viewer' },
      ],
    });

    await service.updateMemberRole('t1', 'u2', 'admin', caller(['admin']));

    expect(ketoDeleteMembership).toHaveBeenCalledWith('t1', 'member', 'u2');
    expect(ketoWriteMembership).toHaveBeenCalledWith('t1', 'admin', 'u2');
    // A write-then-delete would leave the OLD (viewer/"member") relation granting access for
    // however long the delete takes; delete-then-write fails closed instead.
    expect(order).toEqual(['delete', 'write']);
  });

  // WP7-FIX (MAJOR). Keto-first was fail-OPEN for a demotion: the 27 permission names come from the
  // Postgres ROW (AuthService#loadPermissions), so a tuple demoted to `member` while the row still
  // said `admin` left every admin permission in place.
  it('writes Postgres BEFORE Keto when demoting, so the permissions drop first', async () => {
    const order: string[] = [];
    jest.mocked(ketoDeleteMembership).mockImplementation(() => {
      order.push('keto-delete');
      return Promise.resolve();
    });
    jest.mocked(ketoWriteMembership).mockImplementation(() => {
      order.push('keto-write');
      return Promise.resolve();
    });
    const { service, userTenantUpdate } = makeService({
      memberRoles: { u2: 'admin' },
      members: [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'admin' },
      ],
    });
    userTenantUpdate.mockImplementation(() => {
      order.push('pg-update');
      return Promise.resolve({
        userId: 'u2',
        role: 'viewer',
        isDefault: false,
        createdAt: tenantRow.createdAt,
        user: { id: 'u2', email: 'member@b.c', name: 'Member' },
      });
    });

    await service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin']));

    expect(order).toEqual(['pg-update', 'keto-delete', 'keto-write']);
  });

  it('rolls the Postgres row back when a demotion cannot be synced to Keto', async () => {
    jest.mocked(ketoDeleteMembership).mockRejectedValue(new Error('keto down'));
    const { service, userTenantUpdate } = makeService({
      memberRoles: { u2: 'admin' },
      members: [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'admin' },
      ],
    });

    await expect(
      service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin'])),
    ).rejects.toThrow(BadGatewayException);

    // Rolled back to the pre-change role, so the two stores still agree and a retry replays cleanly
    // (leaving the row at 'viewer' would make the retry a no-op that never fixes the stale tuple).
    expect(userTenantUpdate).toHaveBeenCalledTimes(2);
    expect(userTenantUpdate.mock.calls[1][0].data).toEqual({ role: 'admin' });
  });

  // A promotion keeps the Keto-first order: a failure between the delete and the write leaves no
  // tuple at all, which is fail-closed, and the untouched row makes a retry a clean replay.
  it('leaves the Postgres row untouched when a promotion cannot be synced to Keto', async () => {
    jest.mocked(ketoWriteMembership).mockRejectedValue(new Error('keto down'));
    const { service, userTenantUpdate } = makeService({
      memberRoles: { u2: 'viewer' },
      members: [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'viewer' },
      ],
    });

    await expect(
      service.updateMemberRole('t1', 'u2', 'admin', caller(['admin'])),
    ).rejects.toThrow('keto down');
    expect(userTenantUpdate).not.toHaveBeenCalled();
  });

  it("refuses to demote the tenant's last admin", async () => {
    const { service } = makeService({
      memberRoles: { u2: 'admin' },
      members: [{ userId: 'u2', role: 'admin' }],
    });

    await expect(
      service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin'])),
    ).rejects.toThrow(BadRequestException);
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
  });

  it('allows demoting an admin when another admin remains', async () => {
    const { service } = makeService({
      memberRoles: { u2: 'admin' },
      members: [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'admin' },
      ],
    });

    await expect(
      service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin'])),
    ).resolves.toBeDefined();
    expect(ketoDeleteMembership).toHaveBeenCalledWith('t1', 'admin', 'u2');
    expect(ketoWriteMembership).toHaveBeenCalledWith('t1', 'member', 'u2');
  });
});

describe('TenantService.removeMember', () => {
  it('rejects when the target is not a member of the tenant', async () => {
    const { service } = makeService();

    await expect(service.removeMember('t1', 'u2', caller(['admin']))).rejects.toThrow(
      NotFoundException,
    );
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
  });

  it('deletes the Keto tuple before the Postgres row', async () => {
    const order: string[] = [];
    jest.mocked(ketoDeleteMembership).mockImplementation(() => {
      order.push('keto-delete');
      return Promise.resolve();
    });
    const { service, userTenantDelete } = makeService({
      memberRoles: { u2: 'viewer' },
      members: [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'viewer' },
      ],
    });
    userTenantDelete.mockImplementation(() => {
      order.push('pg-delete');
      return Promise.resolve({});
    });

    await service.removeMember('t1', 'u2', caller(['admin']));

    expect(ketoDeleteMembership).toHaveBeenCalledWith('t1', 'member', 'u2');
    // Same fail-closed reasoning as updateMemberRole: if the Postgres delete then fails, the
    // member looks assigned but Keto already denies them — never the reverse.
    expect(order).toEqual(['keto-delete', 'pg-delete']);
  });

  it("refuses to remove the tenant's last admin", async () => {
    const { service } = makeService({
      memberRoles: { u2: 'admin' },
      members: [{ userId: 'u2', role: 'admin' }],
    });

    await expect(service.removeMember('t1', 'u2', caller(['admin']))).rejects.toThrow(
      BadRequestException,
    );
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
  });
});

describe('TenantService.lookupUserByEmail', () => {
  it('returns null when no user has that email', async () => {
    const { service } = makeService({ userByEmail: null });

    await expect(
      service.lookupUserByEmail('t1', 'nobody@b.c', caller(['admin'])),
    ).resolves.toBeNull();
  });

  it('flags isMember true when the match already belongs to the tenant being queried', async () => {
    const { service } = makeService({
      userByEmail: { id: 'u2', email: 'm@b.c', name: 'M' },
      memberRoles: { u2: 'viewer' },
    });

    await expect(service.lookupUserByEmail('t1', 'm@b.c', caller(['admin']))).resolves.toEqual({
      id: 'u2',
      email: 'm@b.c',
      name: 'M',
      isMember: true,
    });
  });

  it('flags isMember false for a match with no membership in this tenant', async () => {
    const { service } = makeService({ userByEmail: { id: 'u2', email: 'm@b.c', name: 'M' } });

    await expect(service.lookupUserByEmail('t1', 'm@b.c', caller(['admin']))).resolves.toEqual({
      id: 'u2',
      email: 'm@b.c',
      name: 'M',
      isMember: false,
    });
  });
});
