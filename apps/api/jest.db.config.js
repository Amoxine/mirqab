/**
 * Jest config for the `*.db-spec.ts` tests, which need a REAL Postgres. `pnpm test` (the `jest` block in
 * package.json, testRegex `.spec.ts`) never matches them: `foo.db-spec.ts` ends in `-spec.ts`. That is
 * deliberate, because they must not run against whatever database happens to be configured, but it also
 * meant nothing ran them, so dedupe, the redaction trigger, tenant isolation, the search partitions and
 * the rest were manual-only until `pnpm test:db` and the CI step that calls it.
 *
 *   OG_THROWAWAY_DATABASE_URL=<url> DATABASE_URL=<the same url> pnpm --filter @open-gateway/api test:db
 *
 * Safety is in the specs, not here: every one imports `common/testing/throwaway-db.guard` FIRST, which
 * throws while the file loads unless DATABASE_URL equals OG_THROWAWAY_DATABASE_URL (and is not the
 * stack's :33002), so running this with neither set refuses instead of touching a default database.
 * Do not add anything here that loads Prisma before the guard.
 *
 * `--runInBand` (set in the script) is required, not a preference: the specs share tables in one database
 * (`og_traffic_search`, `tyk_analytics`) and drop and recreate them. The specs that use the app's own
 * tables (tenants, audit, spec sources) need `prisma migrate deploy` to have run on that database; the
 * pump-table specs create what they need themselves.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.db-spec\\.ts$',
  // Jest's default is 5 s per test. Eight of the ten specs raise it themselves with `jest.setTimeout`
  // (60-120 s); `spec-update` and `spec-source` do not, and their concurrency tests run ten rounds of real
  // transactions, so on a busy machine they failed with "Exceeded timeout of 5000 ms" and the tests after
  // them failed as a cascade (work from the timed-out test was still running on the shared tables). A
  // spec's own `jest.setTimeout` still wins; this is only the default for the ones that set none. Nothing
  // here retries a failing test: for tests that exist to catch races, a retry would hide the very bug.
  testTimeout: 120_000,
};
