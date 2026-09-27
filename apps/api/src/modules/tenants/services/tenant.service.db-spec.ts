import { randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, prisma } from '@open-gateway/database';
import { TenantService } from './tenant.service';
import type { OrgQuotaService } from '../../quotas/services/org-quota.service';
import type { UserPayload } from '../../../common/types';
import { ketoWriteMembership } from '../../../common/ory/keto';
import type * as KetoModule from '../../../common/ory/keto';

/**
 * V1-USR-01 against a REAL Postgres: the `User.email` unique index behind inviteByEmail's 409
 * (AC-USR01.2b, integration half — the mocked-P2002 half is in tenant.service.spec.ts), the member
 * list's tenant scoping with a real second tenant (AC-USR01.1), isLastAdmin's relation filter
 * (AC-USR01.6) and the guarded User cleanup (AC-USR01.2c). Keto is mocked; nothing here talks to Ory.
 * Not part of `jest` (the file name does not match `.spec.ts`) because it needs a THROWAWAY database —
 * never the stack's. Run it:
 *
 *   docker run -d --rm --name og-probe-usr01-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55441:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55441/t?schema=public'
 *   (cd packages/database && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx prisma migrate deploy)
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --testRegex 'tenant\.service\.db-spec\.ts$')
 *   docker rm -f og-probe-usr01-pg
 */

jest.mock('../../../common/ory/keto', () => ({
  ...jest.requireActual<typeof KetoModule>('../../../common/ory/keto'),
  ketoCheck: jest.fn().mockResolvedValue(true),
  ketoWriteMembership: jest.fn().mockResolvedValue(undefined),
  ketoDeleteMembership: jest.fn().mockResolvedValue(undefined),
}));

describe('TenantService (V1-USR-01) on a real Postgres', () => {
  const service = new TenantService({} as OrgQuotaService);
  const run = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  const users: string[] = [];
  // A real member of every tenant this suite makes, so assertPermit runs its actual membership query.
  const adminId = randomUUID();
  const admin = { sub: adminId, email: `admin-${run}@example.test`, roles: ['admin'] } as unknown as UserPayload;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
    await prisma.user.create({ data: { id: adminId, email: admin.email, name: 'admin', kratosIdentityId: `k-${adminId}` } });
    users.push(adminId);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } }); // cascades to user_tenants
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: users } }, { email: { endsWith: `-${run}@example.test` } }] } });
    await prisma.$disconnect();
  });

  async function tenant(): Promise<string> {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({ data: { id, name: 't', slug: `t-${id}`, tykOrgId: `og-${id}` } });
    await prisma.userTenant.create({ data: { userId: adminId, tenantId: id, role: 'admin' } });
    return id;
  }

  /** A claimed (logged-in-before) user, i.e. `kratosIdentityId` set. */
  async function claimedUser(local: string): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({ data: { id, email: `${local}-${run}@example.test`, name: local, kratosIdentityId: `k-${id}` } });
    return id;
  }

  it('the backstop: a duplicate email is a P2002 from the database itself', async () => {
    const email = `raw-${run}@example.test`;
    await prisma.user.create({ data: { email, name: email } });

    const dup = await prisma.user.create({ data: { email, name: email } }).catch((err: unknown) => err);

    expect(dup).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((dup as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('a second invite of the same email — any casing, any tenant — is a 409 and leaves one row, one membership', async () => {
    const [a, b] = [await tenant(), await tenant()];

    const first = await service.inviteByEmail(a, `Dup-${run}@Example.test`, 'viewer', admin);
    await expect(service.inviteByEmail(b, `dup-${run}@example.test`, 'viewer', admin)).rejects.toThrow(ConflictException);

    const rows = await prisma.user.findMany({
      where: { email: { equals: `dup-${run}@example.test`, mode: 'insensitive' } },
      select: { id: true, email: true, kratosIdentityId: true, password: true, userTenants: { select: { tenantId: true } } },
    });
    expect(rows).toEqual([
      { id: first.userId, email: `dup-${run}@example.test`, kratosIdentityId: null, password: null, userTenants: [{ tenantId: a }] },
    ]);
  });

  it("lists and searches one tenant's members only, even when the search matches a member of another tenant", async () => {
    const [a, b] = [await tenant(), await tenant()];
    const alice = await claimedUser('alice-shared');
    const bob = await claimedUser('bob-shared');
    await prisma.userTenant.create({ data: { userId: alice, tenantId: a, role: 'viewer' } });
    await prisma.userTenant.create({ data: { userId: bob, tenantId: b, role: 'viewer' } });
    const invited = await service.inviteByEmail(a, `Carol-Shared-${run}@example.test`, 'viewer', admin);

    const page = await service.findUsers(a, admin, { q: 'SHARED' });

    expect(page.data.map((m) => [m.userId, m.pending]).sort()).toEqual(
      [[alice, false], [invited.userId, true]].sort(),
    );
    expect(page.meta.totalCount).toBe(2);
    // And tenant B sees only its own, for the same term.
    expect((await service.findUsers(b, admin, { q: 'shared' })).data.map((m) => m.userId)).toEqual([bob]);
  });

  it('pages deterministically over rows created in the same instant', async () => {
    const a = await tenant();
    const createdAt = new Date('2026-01-01T00:00:00Z');
    for (const local of ['p1', 'p2', 'p3']) {
      await prisma.userTenant.create({ data: { userId: await claimedUser(local), tenantId: a, role: 'viewer', createdAt } });
    }

    const seen: string[] = [];
    for (const pageNo of [1, 2, 3, 4]) {
      seen.push(...(await service.findUsers(a, admin, { page: pageNo, pageSize: 1 })).data.map((m) => m.userId));
    }

    // The tenant's own admin plus the three same-instant rows: each exactly once across the pages.
    expect(new Set(seen).size).toBe(4);
  });

  it('isLastAdmin: a pending admin invite does not count, and can itself be removed', async () => {
    const a = await tenant();
    // Make the suite's admin the only claimed admin besides the one under test.
    await prisma.userTenant.update({ where: { userId_tenantId: { userId: adminId, tenantId: a } }, data: { role: 'viewer' } });
    const claimed = await claimedUser('sole-admin');
    await prisma.userTenant.create({ data: { userId: claimed, tenantId: a, role: 'admin' } });
    const superAdmin = { sub: randomUUID(), roles: ['super_admin'] } as unknown as UserPayload;
    const pending = await service.inviteByEmail(a, `pending-admin-${run}@example.test`, 'admin', superAdmin);

    await expect(service.updateMemberRole(a, claimed, 'viewer', superAdmin)).rejects.toThrow(BadRequestException);
    await expect(service.removeMember(a, claimed, superAdmin)).rejects.toThrow(BadRequestException);
    await expect(service.removeMember(a, pending.userId, superAdmin)).resolves.toBeUndefined();
  });

  it('a failed Keto write leaves neither the membership nor the User row behind', async () => {
    const a = await tenant();
    jest.mocked(ketoWriteMembership).mockRejectedValueOnce(new Error('keto down'));
    const email = `keto-fail-${run}@example.test`;

    await expect(service.inviteByEmail(a, email, 'viewer', admin)).rejects.toThrow(BadGatewayException);

    expect(await prisma.user.count({ where: { email } })).toBe(0);
    // And the email is free again — a retry succeeds.
    await expect(service.inviteByEmail(a, email, 'viewer', admin)).resolves.toMatchObject({ pending: true });
  });
});
