import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import 'reflect-metadata';
import { TenantService } from './tenant.service';
import type { OrgQuotaService } from '../../quotas/services/org-quota.service';
import type { UserPayload } from '../../../common/types';
import { ketoCheck, ketoDeleteMembership, ketoWriteMembership } from '../../../common/ory/keto';
import type * as KetoModule from '../../../common/ory/keto';
import {
  kratosCreateIdentity,
  kratosSendVerificationEmail,
  kratosWhoAmI,
} from '../../../common/ory/kratos';

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

// TenantService does not import Kratos at all. Mocked anyway so the invite specs can assert it is never
// called (AC-USR01.2d) — and would catch it if someone later "helpfully" wired an email in.
jest.mock('../../../common/ory/kratos');

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

/** A `userTenant.findMany({ include: { user } })` row, as findUsers reads it. */
interface MemberRow {
  userId: string;
  role: string;
  isDefault: boolean;
  createdAt: Date;
  user: { id: string; email: string; name: string; kratosIdentityId: string | null };
}

const memberRow = (userId: string, kratosIdentityId: string | null = `kratos-${userId}`): MemberRow => ({
  userId,
  role: 'viewer',
  isDefault: false,
  createdAt: tenantRow.createdAt,
  user: { id: userId, email: `${userId}@b.c`, name: userId, kratosIdentityId },
});

/** What Prisma throws when `User.email`'s unique index refuses an insert. */
const uniqueEmailViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['email'] },
  });

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
  /** All UserTenant rows in the tenant, for isLastAdmin's findMany (role-change/remove-member specs).
   * `claimed: false` marks a pending invite (`User.kratosIdentityId` null); absent means claimed. */
  members?: { userId: string; role: string; claimed?: boolean }[];
  /** The page findUsers' findMany returns (it asks with `include: { user }`, isLastAdmin does not). */
  memberRows?: MemberRow[];
  /** findUsers' count; defaults to `memberRows.length`. */
  memberCount?: number;
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
  // Two call sites. findUsers asks with `include: { user }` and gets `memberRows`. isLastAdmin gets
  // `members` — minus the pending ones only when its query carries the claimed-only relation filter,
  // so the AC-USR01.6 specs prove the QUERY asks for claimed rows, not merely that some JS filters them.
  const userTenantFindMany = jest.fn((args: QueryArgs & { include?: unknown }) => {
    if (args.include) return Promise.resolve(options.memberRows ?? []);
    const claimedOnly =
      (args.where.user as { kratosIdentityId?: { not?: unknown } } | undefined)?.kratosIdentityId?.not === null;
    return Promise.resolve(
      (options.members ?? [])
        .filter((m) => !claimedOnly || m.claimed !== false)
        .map(({ userId, role }) => ({ userId, role })),
    );
  });
  const userTenantCount = jest.fn((_args: QueryArgs) =>
    Promise.resolve(options.memberCount ?? (options.memberRows ?? []).length),
  );
  // inviteByEmail's user.create hands its row to assignUser, whose userTenant.create reads `user` back.
  const createdUsers = new Map<string, { email: string; name: string }>();
  const userCreate = jest.fn((args: { data: { email: string; name: string } }) => {
    createdUsers.set('u-new', { email: args.data.email, name: args.data.name });
    return Promise.resolve({ id: 'u-new' });
  });
  const userDeleteMany = jest.fn((_args: QueryArgs) => Promise.resolve({ count: 1 }));
  const userTenantCreate = jest.fn(
    (args: { data: { userId: string; tenantId: string; role: string; isDefault?: boolean } }) =>
      Promise.resolve({
        ...args.data,
        isDefault: args.data.isDefault ?? false,
        createdAt: tenantRow.createdAt,
        user: { id: args.data.userId, ...(createdUsers.get(args.data.userId) ?? { email: 'member@b.c', name: 'Member' }) },
      }),
  );
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
  const userFindUnique = jest.fn((_args: QueryArgs) =>
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
      count: userTenantCount,
      create: userTenantCreate,
      update: userTenantUpdate,
      delete: userTenantDelete,
    },
    // No `delete`: inviteByEmail's cleanup must be the guarded deleteMany (a plain delete would throw here).
    user: { findUnique: userFindUnique, create: userCreate, deleteMany: userDeleteMany },
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
    tenantFindUnique,
    userTenantFindUnique,
    userTenantFindMany,
    userTenantCount,
    userTenantCreate,
    userTenantUpdate,
    userTenantDelete,
    userFindUnique,
    userCreate,
    userDeleteMany,
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
    ['inviteByEmail', (s: TenantService, u: UserPayload) => s.inviteByEmail('t9', 'new@b.c', 'viewer', u)],
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
    ['inviteByEmail', (s: TenantService, u: UserPayload) => s.inviteByEmail('t2', 'new@b.c', 'admin', u)],
    ['updateMemberRole', (s: TenantService, u: UserPayload) => s.updateMemberRole('t2', 'u1', 'admin', u)],
    ['removeMember', (s: TenantService, u: UserPayload) => s.removeMember('t2', 'u2', u)],
  ])('%s refuses a member Keto does not grant manage on the target tenant', async (_name, call) => {
    const { service, tenantUpdate, userTenantCreate, userTenantUpdate, userTenantDelete, userCreate } =
      adminOfAnotherTenant();

    await expect(call(service, caller(['admin']))).rejects.toThrow(ForbiddenException);

    expect(ketoCheck).toHaveBeenCalledWith('t2', 'manage', 'u1');
    // Nothing was written on the way to the refusal.
    for (const write of [tenantUpdate, userTenantCreate, userTenantUpdate, userTenantDelete, userCreate]) {
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

  // V1-USR-01 / pre-mortem #3: inviteByEmail stores the lowercased form, so a lookup typed with
  // different casing must still land on that row.
  it('lowercases the email before looking it up', async () => {
    const { service, userFindUnique } = makeService();

    await service.lookupUserByEmail('t1', 'Bob@X.com', caller(['admin']));

    expect(userFindUnique.mock.calls[0][0].where).toEqual({ email: 'bob@x.com' });
  });
});

// V1-USR-01 / AC-USR01.1 + AC-USR01.4. `GET :id/users` used to return every member as a plain array.
describe('TenantService.findUsers — pagination, search, pending', () => {
  it('defaults to page 1 of 20, newest first with a stable tiebreak, scoped to the tenant', async () => {
    const { service, userTenantFindMany, userTenantCount } = makeService({
      memberRows: [memberRow('u2')],
      memberCount: 1,
    });

    const result = await service.findUsers('t1', caller(['admin']));

    const args = userTenantFindMany.mock.calls[0][0] as QueryArgs & Record<string, unknown>;
    expect(args.where).toEqual({ tenantId: 't1' });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { userId: 'asc' }]);
    expect(userTenantCount.mock.calls[0][0].where).toEqual({ tenantId: 't1' });
    expect(result.meta).toEqual({ page: 1, pageSize: 20, totalCount: 1, totalPages: 1 });
  });

  it('pages with skip/take and reports totals from a count that carries the same filter', async () => {
    const { service, userTenantFindMany, userTenantCount } = makeService({ memberCount: 25 });

    const result = await service.findUsers('t1', caller(['admin']), { page: 3, pageSize: 10, q: 'bob' });

    const args = userTenantFindMany.mock.calls[0][0] as QueryArgs & Record<string, unknown>;
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    // Without the same `where`, the pager would count every member while listing only the matches.
    expect(userTenantCount.mock.calls[0][0].where).toEqual(args.where);
    expect(result.meta).toEqual({ page: 3, pageSize: 10, totalCount: 25, totalPages: 3 });
  });

  // The two-tenant proof against a real Postgres is tenant.service.db-spec.ts; this pins the shape
  // that makes it hold — the search nested under `user`, `tenantId` still ANDed at the top.
  it('searches inside the tenant only: a trimmed, case-insensitive name/email match nested under user', async () => {
    const { service, userTenantFindMany } = makeService();

    await service.findUsers('t1', caller(['admin']), { q: '  Bob ' });

    expect(userTenantFindMany.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      user: {
        OR: [
          { name: { contains: 'Bob', mode: 'insensitive' } },
          { email: { contains: 'Bob', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('ignores a whitespace-only q rather than matching nothing', async () => {
    const { service, userTenantFindMany } = makeService();

    await service.findUsers('t1', caller(['admin']), { q: '   ' });

    expect(userTenantFindMany.mock.calls[0][0].where).toEqual({ tenantId: 't1' });
  });

  it('refuses before querying members when the tenant does not exist', async () => {
    const { service, tenantFindUnique, userTenantFindMany } = makeService();
    tenantFindUnique.mockResolvedValue(null);

    await expect(service.findUsers('t1', caller(['admin']))).rejects.toThrow(NotFoundException);
    expect(userTenantFindMany).not.toHaveBeenCalled();
  });

  // AC-USR01.4: pending is the column, nothing else — the same row flips when (and only when)
  // resolveOrProvisionUser sets kratosIdentityId on first verified login.
  it('derives pending from kratosIdentityId alone, and never returns the identity id itself', async () => {
    const before = makeService({ memberRows: [memberRow('u2', null)] });
    const after = makeService({ memberRows: [memberRow('u2', 'kratos-abc')] });

    const [pendingRow] = (await before.service.findUsers('t1', caller(['admin']))).data;
    const [claimedRow] = (await after.service.findUsers('t1', caller(['admin']))).data;

    const sameRow = {
      userId: 'u2',
      email: 'u2@b.c',
      name: 'u2',
      role: 'viewer',
      isDefault: false,
      createdAt: tenantRow.createdAt,
    };
    expect(pendingRow).toEqual({ ...sameRow, pending: true });
    expect(claimedRow).toEqual({ ...sameRow, pending: false });
    expect(Object.keys(claimedRow)).not.toContain('kratosIdentityId');
  });
});

// V1-USR-01 (plan §3 Option F): invite an email with no account yet — a User row with no Kratos
// identity, assigned through the unmodified assignUser, claimed later by the login route.
describe('TenantService.inviteByEmail', () => {
  // AC-USR01.2a. Compensation, not a transaction — the partial-failure half is AC-USR01.2c below.
  it('creates one lowercased, identity-less User and one membership through assignUser, Keto tuple included', async () => {
    const { service, userCreate, userTenantCreate, userDeleteMany } = makeService();

    const result = await service.inviteByEmail('t1', 'Bob@X.com', 'operator', caller(['admin']));

    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(userCreate.mock.calls[0][0]).toEqual({
      data: { email: 'bob@x.com', name: 'Bob@X.com', password: null, kratosIdentityId: null },
      select: { id: true },
    });
    expect(userTenantCreate).toHaveBeenCalledTimes(1);
    expect(userTenantCreate.mock.calls[0][0].data).toEqual({
      userId: 'u-new',
      tenantId: 't1',
      role: 'operator',
      isDefault: false,
    });
    expect(ketoWriteMembership).toHaveBeenCalledTimes(1);
    expect(ketoWriteMembership).toHaveBeenCalledWith('t1', 'member', 'u-new');
    expect(userDeleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      userId: 'u-new',
      email: 'bob@x.com',
      name: 'Bob@X.com',
      role: 'operator',
      isDefault: false,
      createdAt: tenantRow.createdAt,
      pending: true,
    });
  });

  // AC-USR01.2b, UNIT half (mocked Prisma). The real unique index is proven separately in
  // tenant.service.db-spec.ts — neither substitutes for the other.
  it('maps a P2002 on User.email to a 409 and writes nothing else', async () => {
    const { service, userCreate, userTenantCreate, userDeleteMany } = makeService();
    userCreate.mockRejectedValue(uniqueEmailViolation());

    const attempt = service.inviteByEmail('t1', 'Taken@B.c', 'viewer', caller(['admin']));

    await expect(attempt).rejects.toThrow(ConflictException);
    await expect(attempt).rejects.toThrow('"taken@b.c" is already invited or already has an account');
    expect(userTenantCreate).not.toHaveBeenCalled();
    expect(ketoWriteMembership).not.toHaveBeenCalled();
    // Nothing was created, so there is nothing to clean up — and the existing row must not be touched.
    expect(userDeleteMany).not.toHaveBeenCalled();
  });

  it('propagates any other create failure unchanged, not dressed up as a conflict', async () => {
    const { service, userCreate } = makeService();
    userCreate.mockRejectedValue(new Error('connection reset'));

    await expect(service.inviteByEmail('t1', 'a@b.c', 'viewer', caller(['admin']))).rejects.toThrow(
      'connection reset',
    );
  });

  // AC-USR01.2c.
  it('removes the User row it created when assignUser fails on Keto — after assignUser removed its membership', async () => {
    const order: string[] = [];
    jest.mocked(ketoWriteMembership).mockRejectedValue(new Error('keto down'));
    const { service, userTenantDelete, userDeleteMany } = makeService();
    userTenantDelete.mockImplementation(() => {
      order.push('membership-delete');
      return Promise.resolve({});
    });
    userDeleteMany.mockImplementation(() => {
      order.push('user-delete');
      return Promise.resolve({ count: 1 });
    });

    await expect(
      service.inviteByEmail('t1', 'new@b.c', 'viewer', caller(['admin'])),
    ).rejects.toThrow(BadGatewayException);

    // Guarded: only while nothing references the row. A plain delete would cascade into any
    // membership a concurrent request attached to it in the meantime.
    expect(userDeleteMany).toHaveBeenCalledWith({ where: { id: 'u-new', userTenants: { none: {} } } });
    expect(order).toEqual(['membership-delete', 'user-delete']);
  });

  it('removes it too when assignUser fails before writing anything (tenant gone)', async () => {
    const { service, tenantFindUnique, userTenantCreate, userDeleteMany } = makeService();
    tenantFindUnique.mockResolvedValue(null);

    await expect(
      service.inviteByEmail('t1', 'new@b.c', 'viewer', caller(['admin'])),
    ).rejects.toThrow(NotFoundException);

    expect(userTenantCreate).not.toHaveBeenCalled();
    expect(userDeleteMany).toHaveBeenCalledWith({ where: { id: 'u-new', userTenants: { none: {} } } });
  });

  // AC-USR01.2d: asserted as never-called, not merely "not observed".
  it('never calls Kratos and makes no outbound HTTP request', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this spec'));
    try {
      const { service } = makeService();

      await service.inviteByEmail('t1', 'new@b.c', 'viewer', caller(['admin']));

      expect(kratosCreateIdentity).not.toHaveBeenCalled();
      expect(kratosSendVerificationEmail).not.toHaveBeenCalled();
      expect(kratosWhoAmI).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // AC-USR01.2f: refused BEFORE the create — zero create calls, not a create-then-delete.
  it.each([
    ['Keto denies manage on the tenant', { denyManage: true, member: true, role: 'viewer' }],
    ['the caller is not a member', { denyManage: false, member: false, role: 'viewer' }],
    ['the role is super_admin', { denyManage: false, member: true, role: 'super_admin' }],
    ['the role is SUPER_ADMIN', { denyManage: false, member: true, role: 'SUPER_ADMIN' }],
  ])('refuses before creating anything when %s', async (_label, { denyManage, member, role }) => {
    if (denyManage) {
      jest.mocked(ketoCheck).mockImplementation((_t, permit) => Promise.resolve(permit === 'view'));
    }
    const { service, userCreate, userDeleteMany, userTenantCreate } = makeService({ member });

    await expect(service.inviteByEmail('t1', 'new@b.c', role, caller(['admin']))).rejects.toThrow(
      ForbiddenException,
    );

    expect(userCreate).not.toHaveBeenCalled();
    expect(userDeleteMany).not.toHaveBeenCalled();
    expect(userTenantCreate).not.toHaveBeenCalled();
    expect(ketoWriteMembership).not.toHaveBeenCalled();
  });

  it('asks Keto for manage on the target tenant before the create, on the happy path too', async () => {
    const { service, userCreate } = makeService();

    await service.inviteByEmail('t1', 'new@b.c', 'viewer', caller(['admin']));

    const manageCall = jest.mocked(ketoCheck).mock.calls.findIndex(([t, permit]) => t === 't1' && permit === 'manage');
    expect(manageCall).toBeGreaterThanOrEqual(0);
    expect(jest.mocked(ketoCheck).mock.invocationCallOrder[manageCall]).toBeLessThan(
      userCreate.mock.invocationCallOrder[0],
    );
  });
});

// V1-USR-01 / AC-USR01.6. A pending admin invite is an admin row nobody can log in as yet.
describe('TenantService last-admin guard ignores pending invites', () => {
  const claimedAdminPlusPendingAdmin = {
    memberRoles: { u2: 'admin', u3: 'admin' },
    members: [
      { userId: 'u2', role: 'admin' },
      { userId: 'u3', role: 'admin', claimed: false },
    ],
  };

  it('counts only claimed rows — the relation filter is in the query itself', async () => {
    const { service, userTenantFindMany } = makeService(claimedAdminPlusPendingAdmin);

    await expect(service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin']))).rejects.toThrow(
      BadRequestException,
    );

    expect(userTenantFindMany.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      user: { kratosIdentityId: { not: null } },
    });
  });

  it('still refuses to demote the only claimed admin when a pending admin invite exists', async () => {
    const { service } = makeService(claimedAdminPlusPendingAdmin);

    await expect(service.updateMemberRole('t1', 'u2', 'viewer', caller(['admin']))).rejects.toThrow(
      'Cannot change role: this is the last admin of the tenant',
    );
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
  });

  it('still refuses to remove the only claimed admin when a pending admin invite exists', async () => {
    const { service } = makeService(claimedAdminPlusPendingAdmin);

    await expect(service.removeMember('t1', 'u2', caller(['admin']))).rejects.toThrow(
      'Cannot remove the last admin of the tenant',
    );
    expect(ketoDeleteMembership).not.toHaveBeenCalled();
  });

  it('allows removing the pending admin row itself — it is not the one being protected', async () => {
    const { service, userTenantDelete } = makeService(claimedAdminPlusPendingAdmin);

    await expect(service.removeMember('t1', 'u3', caller(['admin']))).resolves.toBeUndefined();

    expect(ketoDeleteMembership).toHaveBeenCalledWith('t1', 'admin', 'u3');
    expect(userTenantDelete).toHaveBeenCalledWith({
      where: { userId_tenantId: { userId: 'u3', tenantId: 't1' } },
    });
  });
});
