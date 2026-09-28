/**
 * Pins `MIGRATION_CANDIDATE_WHERE`, the clause `migrate-users-to-kratos.ts` uses to pick which `User`
 * rows it migrates (plan pre-mortem #2 / AC-USR01.5).
 *
 * What it protects: an invite-pending row (`password: null`, created by `inviteByEmail`) must never be
 * a migration candidate. The migration would bind such a row to any Kratos identity already registered
 * under that email (its "bind to existing identity by email" branch has no verified-address check), so
 * dropping `password: { not: null }` from the clause reopens that hole.
 *
 * Deliberately a literal comparison, not a re-implementation of how Prisma evaluates `{ not: null }`:
 * Prisma owns that meaning; this only fails if the clause stops being exactly this.
 *
 * Imports ONLY ./migration-candidate (pure, no I/O). Never import ./migrate-users-to-kratos here: it
 * runs `main()` on import, i.e. the real migration against DATABASE_URL and Kratos.
 *
 * No test framework in this package — same convention as `prisma/permissions.check.ts`: plain
 * assertions, tsx, non-zero exit on throw. Wired into `pnpm --filter @open-gateway/database test`.
 */
import assert from 'node:assert/strict';
import { MIGRATION_CANDIDATE_WHERE } from './migration-candidate';

assert.deepStrictEqual(
  MIGRATION_CANDIDATE_WHERE,
  { kratosIdentityId: null, password: { not: null } },
  'MIGRATION_CANDIDATE_WHERE changed: it must exclude rows with `password: null` (invite-pending users), ' +
    'which the migration script would otherwise bind to an existing Kratos identity found by email.',
);

console.log('✅ MIGRATION_CANDIDATE_WHERE is exactly { kratosIdentityId: null, password: { not: null } }');
