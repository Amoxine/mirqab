/**
 * One-time (but idempotent) import of existing Postgres `User` rows into Ory Kratos.
 *
 * Kratos verifies the hash's own prefix, so importing the existing bcrypt `$2b$12$...` hash as
 * `credentials.password.config.hashed_password` lets every user log in with their ORIGINAL
 * password — no reset required (see infra/ory/kratos/kratos.yml's `hashers` comment, verified
 * live on v26.2.0).
 *
 * Idempotent: for each user, looks up an existing Kratos identity by email first and skips
 * creation if found — safe to re-run against partially-migrated state. Only queries users with
 * no `kratosIdentityId` yet (see migration 20260920120000_kratos_identity_id) AND a non-null
 * `password` (`MIGRATION_CANDIDATE_WHERE`, in ./migration-candidate.ts) — an invite-pending row
 * (`password: null`) was never a pre-Kratos account and must never reach the "bind to existing
 * identity by email" branch below, which has no verified-address check. A re-run is cheap once
 * most rows are mapped.
 *
 * This file runs `main()` on import. Never import it from a check or test; import the side-effect-free
 * ./migration-candidate.ts instead.
 *
 * Rows whose `password` isn't a real hash (no `$` prefix — e.g. the random hex placeholder
 * apps/web/src/app/oauth2/login/route.ts assigns to web-provisioned users) are skipped with a
 * warning rather than sent to Kratos, since `createIdentity` throws on any non-2xx and would
 * otherwise abort the whole import over one bad row.
 *
 * Usage:
 *   pnpm --filter @open-gateway/database exec tsx scripts/migrate-users-to-kratos.ts [--dry-run]
 *
 * Env:
 *   KRATOS_ADMIN_URL   default http://127.0.0.1:33013 (loopback-only per infra/docker-compose.yml)
 */
import { PrismaClient } from '@prisma/client';
import { MIGRATION_CANDIDATE_WHERE } from './migration-candidate';

const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL ?? 'http://127.0.0.1:33013';
const SCHEMA_ID = 'default'; // infra/ory/kratos/kratos.yml identity.default_schema_id
const dryRun = process.argv.includes('--dry-run');

const prisma = new PrismaClient();

interface KratosIdentity {
  id: string;
  traits: { email: string; name?: string };
}

interface MigrationUser {
  id: string;
  email: string;
  name: string;
  password: string | null;
}

async function findExistingIdentity(email: string): Promise<KratosIdentity | null> {
  const url = `${KRATOS_ADMIN_URL}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kratos lookup failed for ${email}: ${String(res.status)} ${await res.text()}`);
  }
  const identities = (await res.json()) as KratosIdentity[];
  return identities[0] ?? null;
}

async function createIdentity(email: string, name: string, hashedPassword: string): Promise<KratosIdentity> {
  const res = await fetch(`${KRATOS_ADMIN_URL}/admin/identities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_id: SCHEMA_ID,
      traits: { email, name },
      credentials: {
        password: { config: { hashed_password: hashedPassword } },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Kratos create failed for ${email}: ${String(res.status)} ${await res.text()}`);
  }
  return (await res.json()) as KratosIdentity;
}

async function main() {
  const users: MigrationUser[] = await prisma.user.findMany({
    where: MIGRATION_CANDIDATE_WHERE,
    select: { id: true, email: true, name: true, password: true },
  });

  const mapping: { userId: string; email: string; kratosIdentityId: string; created: boolean }[] = [];

  for (const user of users) {
    const existing = await findExistingIdentity(user.email);
    let identity: KratosIdentity;

    if (existing) {
      identity = existing;
    } else {
      const hashedPassword = user.password;
      if (!hashedPassword?.startsWith('$')) {
        console.warn(
          `Skipping ${user.email}: no existing Kratos identity and password is not a real hash ` +
            '(likely the random placeholder web self-service signup assigns) — investigate before migrating this user.',
        );
        continue;
      }
      if (dryRun) {
        console.log(`[dry-run] would create Kratos identity for ${user.email}`);
        continue;
      }
      identity = await createIdentity(user.email, user.name, hashedPassword);
      console.log(`created Kratos identity ${identity.id} for ${user.email}`);
    }

    mapping.push({ userId: user.id, email: user.email, kratosIdentityId: identity.id, created: !existing });

    if (!dryRun) {
      await prisma.user.update({ where: { id: user.id }, data: { kratosIdentityId: identity.id } });
    }
  }

  console.log(JSON.stringify(mapping, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
