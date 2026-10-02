/**
 * Pins that `seed.ts` REFUSES before it touches a database when the admin credentials are unusable.
 *
 * `admin-credentials.check.ts` proves the decision function; this proves the seed actually obeys it
 * and does so first. The property that matters is ordering: under a bad NODE_ENV the process must
 * exit non-zero without having written anything, so a half-seeded production database (roles and
 * permissions present, no usable admin, or worse a default one) cannot exist. Evidence that nothing
 * ran: exit status 1, the refusal text on stderr, and no "Seeding database" banner on stdout.
 *
 * Runs the real `seed.ts` in a child process. DATABASE_URL is pointed at a dead address
 * (127.0.0.1:1), never at a database: if the gate ever stopped coming first, the child would fail
 * to connect instead of seeding anything, and this check would fail on the missing refusal text.
 * The child's environment is built from scratch rather than inherited, so a DATABASE_URL in the
 * parent shell can never reach it.
 *
 * Needs the generated Prisma client (`pnpm db:generate`), like anything that imports this package;
 * CI generates it before `pnpm test`. No test framework — same convention as the other checks here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const seed = join(__dirname, 'seed.ts');
const packageRoot = dirname(__dirname);
const DEAD_DATABASE = 'postgresql://nobody:nobody@127.0.0.1:1/none';

function runSeed(extraEnv: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', seed], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: DEAD_DATABASE, ...extraEnv },
  });
}

const refusals: { label: string; env: Record<string, string> }[] = [
  { label: 'NODE_ENV=production, no ADMIN_*', env: { NODE_ENV: 'production' } },
  { label: 'NODE_ENV=Production (the case that used to fall through to the default)', env: { NODE_ENV: 'Production' } },
  { label: 'NODE_ENV unset', env: {} },
  {
    label: 'production with the dev defaults supplied explicitly',
    env: { NODE_ENV: 'production', ADMIN_EMAIL: 'admin@opengateway.io', ADMIN_PASSWORD: 'Admin123!' },
  },
];

for (const { label, env } of refusals) {
  const run = runSeed(env);
  assert.equal(run.error, undefined, `${label}: the child could not be run: ${String(run.error)}`);
  assert.equal(run.status, 1, `${label}: expected exit 1, got ${String(run.status)}\n${run.stderr}`);
  assert.match(run.stderr, /Refusing to seed/, `${label}: no refusal message — did the seed fail for another reason?\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /Seeding database/, `${label}: the seed started before it refused`);
  // Every one of these is about the admin email first: it is what an operator who forgot the variable
  // (or supplied the default) needs to see.
  assert.match(run.stderr, /ADMIN_EMAIL/, `${label}: the refusal does not name ADMIN_EMAIL\n${run.stderr}`);
}

console.log(`✅ seed.ts refuses before any database access: ${String(refusals.length)} bad environments, exit 1 each`);
