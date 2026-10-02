import { PrismaClient } from '@prisma/client';
import { tykOrgIdFor } from '../src/index';
import { PERMISSIONS } from './permissions';
import { DEV_ADMIN_PASSWORD, resolveAdminCredentials } from './admin-credentials';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Role definitions with their permissions
const ROLE_DEFINITIONS = {
  super_admin: {
    description: 'Full system access — all permissions',
    permissions: PERMISSIONS.map((p) => p.name),
  },
  admin: {
    description: 'Tenant admin — manage APIs, keys, users, roles',
    permissions: PERMISSIONS.filter(
      (p) => !['tenant:delete', 'role:delete'].includes(p.name),
    ).map((p) => p.name),
  },
  operator: {
    description: 'Operator — manage APIs and keys, read-only users/roles',
    permissions: PERMISSIONS.filter((p) =>
      [
        'api:read',
        'api:create',
        'api:update',
        'key:read',
        'key:create',
        'key:update',
        'key:revoke',
        'user:read',
        'role:read',
        'analytics:read',
        'audit:read',
        'settings:read',
        // WP18, DoD-OWNER 1: `operator` is the one explicit list, so a new permission reaches it
        // only by being named here. Operator already holds key:create/key:update and WP19 makes
        // key->plan assignment a select, so it has to be able to SEE plans and products to assign
        // one. It gets no create/update/delete on either: commercial config is the tenant admin's,
        // matching operator's existing read-only posture on users and roles.
        'plan:read',
        'product:read',
        // WP26a, DoD-OWNER 1: read-only, not create/delete — uploading or removing a certificate
        // means handling private key material, a materially more sensitive action than the rest of
        // operator's "manage APIs and keys" remit, so it stays with admin (auto-granted, not listed
        // in the exclusion filter above) rather than joining operator's explicit list.
        'cert:read',
      ].includes(p.name),
    ).map((p) => p.name),
  },
  viewer: {
    description: 'Viewer — read-only access to all resources',
    permissions: PERMISSIONS.filter((p) => p.action === 'read' || p.action === 'export').map(
      (p) => p.name,
    ),
  },
};

/**
 * Which Keto relation a seeded role maps to. Kept in sync by hand with `relationForRole` in
 * apps/api/src/common/ory/keto.ts — the same reason the permission catalog above is duplicated:
 * this is seed data, and the seed must not import from the API app.
 */
const relationForRole = (role: string): 'member' | 'admin' =>
  ['admin', 'super_admin'].includes(role.toLowerCase()) ? 'admin' : 'member';

/**
 * Upserts one relation tuple. Keto's PUT is idempotent, so re-seeding is free.
 *
 * Retried briefly because install.sh waits for postgres and redis to be healthy before seeding, but
 * not for keto — the container is usually up by now, occasionally it is a second behind.
 * ponytail: fixed 5 × 2s, not backoff; if this ever needs more, add `wait_healthy "keto"` to
 * install.sh instead of growing a retry policy here.
 */
async function writeKetoMembership(
  tenantId: string,
  relation: 'member' | 'admin',
  userId: string,
): Promise<void> {
  const url = new URL(
    '/admin/relation-tuples',
    process.env.ORY_KETO_WRITE_URL ?? 'http://keto:4467',
  );
  const body = JSON.stringify({ namespace: 'Tenant', object: tenantId, relation, subject_id: userId });

  let lastError = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Loud, not skipped: a missing tuple locks the user out of the tenant they were just seeded into.
  throw new Error(
    `Could not write the Keto tuple Tenant:${tenantId}#${relation}@${userId} (${lastError}). ` +
      `Is Keto running and ORY_KETO_WRITE_URL correct (${url.origin})? Write it by hand with: ` +
      `curl -X PUT ${url.href} -H 'Content-Type: application/json' -d '${body}'`,
  );
}

async function main() {
  // Resolved FIRST, before the first write: an unusable admin credential must stop the seed with
  // nothing half-created, not fail at step 4 after roles and permissions have already been written.
  // The gate fails closed (see ./admin-credentials.ts): the dev default needs a literal
  // NODE_ENV=development|test and no ADMIN_*, so a host-side `pnpm db:seed` sets NODE_ENV itself.
  const admin = resolveAdminCredentials(process.env);
  if (!admin.ok) {
    console.error('❌ Refusing to seed: the admin credentials are not usable.');
    for (const problem of admin.errors) console.error(`   - ${problem}`);
    console.error(
      '   In production pass them to the seed container, e.g. `docker compose ... run --rm -e ADMIN_EMAIL ' +
        '-e ADMIN_PASSWORD api npx prisma db seed` (docs/go-live.md). For a local development database ' +
        'run it with NODE_ENV=development and neither variable set (docs/development.md).',
    );
    process.exit(1);
  }

  console.log('🌱 Seeding database...');

  // ─── 1. Create all permissions (idempotent) ──────────────────────
  console.log('  Creating permissions...');
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { resource_action: { resource: perm.resource, action: perm.action } },
      update: {},
      create: perm,
    });
  }
  console.log(`  ✅ ${PERMISSIONS.length} permissions ensured`);

  // ─── 2. Create default tenant (idempotent) ───────────────────────
  console.log('  Creating default tenant...');
  // Fixed id so the derived Tyk org (`tykOrgIdFor`) is stable across re-seeds — a re-seed that
  // changed it would orphan every definition, policy and key already stamped with the old one.
  const defaultTenantId = '00000000-0000-4000-8000-000000000001';
  const defaultTenant = await prisma.tenant.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      id: defaultTenantId,
      tykOrgId: tykOrgIdFor(defaultTenantId),
      name: 'Default Organization',
      slug: 'default',
      plan: 'ENTERPRISE',
      status: 'ACTIVE',
    },
  });
  console.log(`  ✅ Tenant "${defaultTenant.name}" (slug: ${defaultTenant.slug})`);

  // ─── 3. Create roles for default tenant (idempotent) ─────────────
  console.log('  Creating roles...');
  const roleMap: Record<string, { id: string }> = {};

  for (const [roleName, definition] of Object.entries(ROLE_DEFINITIONS)) {
    const role = await prisma.role.upsert({
      where: { name_tenantId: { name: roleName, tenantId: defaultTenant.id } },
      update: { description: definition.description },
      create: {
        name: roleName,
        tenantId: defaultTenant.id,
        description: definition.description,
      },
    });
    roleMap[roleName] = { id: role.id };

    // Assign permissions
    const permissions = await prisma.permission.findMany({
      where: { name: { in: definition.permissions } },
    });

    for (const perm of permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: perm.id,
        },
      });
    }
    console.log(`  ✅ Role "${roleName}" with ${permissions.length} permissions`);
  }

  // ─── 4. Create default admin user (idempotent) ───────────────────
  console.log('  Creating default admin user...');
  const adminEmail = admin.email;
  const passwordHash = await bcrypt.hash(admin.password, 12);
  // Asked BEFORE the upsert, because the upsert below only writes the password when it CREATES the
  // row: for an existing user it leaves the password alone but still reactivates the account and
  // (next block) makes it super_admin. The log has to say which of the two happened.
  const adminExisted = (await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } })) !== null;

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: 'System Administrator',
      status: 'ACTIVE',
    },
    create: {
      email: adminEmail,
      name: 'System Administrator',
      password: passwordHash,
      status: 'ACTIVE',
    },
  });

  // Assign admin user to default tenant with super_admin role
  await prisma.userTenant.upsert({
    where: {
      userId_tenantId: { userId: adminUser.id, tenantId: defaultTenant.id },
    },
    update: { role: 'super_admin', isDefault: true },
    create: {
      userId: adminUser.id,
      tenantId: defaultTenant.id,
      role: 'super_admin',
      isDefault: true,
    },
  });

  // Only the published dev default is ever echoed; an operator-chosen password must not reach logs.
  if (adminExisted) {
    console.log(
      `  ✅ Admin user "${adminUser.email}" already existed: its password was NOT changed, ` +
        'and it is now ACTIVE and super_admin of the default tenant',
    );
  } else {
    console.log(
      `  ✅ Admin user "${adminUser.email}" created` +
        (admin.password === DEV_ADMIN_PASSWORD ? ` (password: ${admin.password})` : ' with the password from ADMIN_PASSWORD'),
    );
  }

  // ─── 5. Publish every membership to Keto (idempotent) ────────────
  // Authorization is fail-closed: the API resolves a session's tenant only if Keto confirms the
  // membership (`check(Tenant:<id>#view@<user>)`, see apps/api/src/common/ory/keto.ts). A row here
  // with no tuple means that user is a member in Postgres and 403 everywhere in the app, so the two
  // are written together. Every OTHER membership write goes through TenantService, which does the
  // same.
  console.log('  Publishing tenant memberships to Keto...');
  const memberships = await prisma.userTenant.findMany({
    select: { userId: true, tenantId: true, role: true },
  });

  for (const { userId, tenantId, role } of memberships) {
    await writeKetoMembership(tenantId, relationForRole(role), userId);
  }
  console.log(`  ✅ ${memberships.length} membership tuple(s) written`);

  // ─── 6. Summary ──────────────────────────────────────────────────
  console.log('\n🎉 Seed complete!');
  console.log(`   Users:      ${await prisma.user.count()}`);
  console.log(`   Tenants:    ${await prisma.tenant.count()}`);
  console.log(`   Roles:      ${await prisma.role.count()}`);
  console.log(`   Permissions: ${await prisma.permission.count()}`);
  console.log(`   RolePermissions: ${await prisma.rolePermission.count()}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
