/**
 * Which `User` rows `migrate-users-to-kratos.ts` may touch.
 *
 * Kept in its OWN module on purpose: `migrate-users-to-kratos.ts` calls `main()` at import time (it
 * opens a PrismaClient on DATABASE_URL and writes to Kratos and Postgres), so anything that only
 * needs this constant — like `migrate-users-to-kratos.check.ts` — must import it from here. Do not
 * add a PrismaClient, `fetch`, env read or top-level call to this file.
 *
 * Only rows with no `kratosIdentityId` yet (see migration 20260920120000_kratos_identity_id) AND a
 * non-null `password`. An invite-pending row (`password: null`, created by `inviteByEmail`) was never
 * a pre-Kratos account and must never reach the migration script's "bind to the existing Kratos
 * identity found by email" branch, which has no verified-address check.
 */
export const MIGRATION_CANDIDATE_WHERE = {
  kratosIdentityId: null,
  password: { not: null },
} as const;
