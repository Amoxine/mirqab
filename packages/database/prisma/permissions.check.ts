/**
 * R13's tripwire: the seeded permission catalogue must equal this EXPLICIT list. Any new permission
 * — especially anything platform-scoped, which A1 (plan §2.5) says should never exist — fails this
 * until someone consciously adds it here, which is the point: silence is not an option.
 *
 * Run with `tsx prisma/permissions.check.ts` (wired to `pnpm --filter @open-gateway/database test`,
 * and so to the root `pnpm test`). No test framework: `PERMISSIONS` is a plain array and `assert` is
 * the whole job — see the repo's own "lazy code still needs ONE runnable check" convention.
 *
 * History: 27 pre-existing + 8 at WP18 (plan:*, product:*) = 35 (WP19, verified against a fresh
 * manual count — no automated check existed yet). +3 at WP26a (cert:read|create|delete) = 38.
 */
import assert from 'node:assert/strict';
import { PERMISSIONS } from './permissions';

const EXPECTED = [
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
].sort();

const actual = PERMISSIONS.map((p) => p.name).sort();

assert.deepStrictEqual(
  actual,
  EXPECTED,
  `Permission catalogue drifted from the expected ${String(EXPECTED.length)}: ` +
    `missing ${JSON.stringify(EXPECTED.filter((n) => !actual.includes(n)))}, ` +
    `unexpected ${JSON.stringify(actual.filter((n) => !EXPECTED.includes(n)))}. ` +
    'If this is a deliberate new permission, add it to EXPECTED above with a comment saying why — ' +
    'if it looks platform-scoped, stop and reopen O12 instead (plan §2.5, R13).',
);
assert.strictEqual(new Set(actual).size, actual.length, 'Duplicate permission name in the catalogue.');
for (const p of PERMISSIONS) {
  assert.strictEqual(p.name, `${p.resource}:${p.action}`, `${p.name}: name must be "resource:action"`);
}

console.log(`✅ permission catalogue: ${String(PERMISSIONS.length)} permissions, matches the expected list`);
