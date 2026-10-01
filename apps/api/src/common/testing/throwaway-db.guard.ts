/**
 * Import this FIRST in every `*.db-spec.ts`, before anything that loads Prisma.
 *
 * It throws while the test file loads, so no hook runs at all. A guard inside `beforeAll` is not enough:
 * Jest still runs `afterAll`, whose cleanup drops tables, and with DATABASE_URL unset Prisma falls back to
 * `packages/database/.env` — the live stack database. That is how `tyk_analytics` was once dropped.
 */
const url = process.env.DATABASE_URL;
if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
  throw new Error('Refusing to load: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
}

export {};
