/**
 * Source-level guard on `seed.ts`: the admin account's email and password come from
 * `resolveAdminCredentials`, and nothing else.
 *
 * `admin-credentials.check.ts` proves the decision function and `seed-refusal.check.ts` proves the seed
 * REFUSES when the function says no. Neither would notice the seed going back to
 * `const adminPassword = 'Admin123!'` for the accepted case: the function would still be correct and
 * still be called, and its answer would simply stop being used. This pins the wiring itself, so that
 * regression fails `pnpm test` instead of shipping a published password under a green build.
 *
 * It reads text, not behaviour, and says so: it cannot prove the upsert RUNS with those values, only
 * that the code which builds it takes them from the resolver. Comments are stripped before matching so a
 * comment that mentions the default cannot trip it, and a commented-out line cannot satisfy it.
 *
 * SEED_UNDER_TEST points it at another file so the guard can be shown to fail on a mutated copy.
 * Plain assertions, tsx, non-zero exit on throw — same convention as the other checks in this package.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const seedPath = process.env.SEED_UNDER_TEST ?? join(__dirname, 'seed.ts');
const code = readFileSync(seedPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// 1. No hard-coded default anywhere in the code.
assert.ok(!code.includes('Admin123!'), 'seed.ts contains the literal development password "Admin123!"');
assert.ok(!/admin@opengateway\.io/i.test(code), 'seed.ts contains the literal development email "admin@opengateway.io"');
assert.ok(!/bcrypt\.hash\(\s*['"`]/.test(code), 'seed.ts hashes a string literal: the password must come from the resolver');

// 2. The resolver is imported and called with the real environment, not a hand-built object.
assert.match(
  code,
  /import\s*\{[^}]*\bresolveAdminCredentials\b[^}]*\}\s*from\s*['"]\.\/admin-credentials['"]/,
  'seed.ts does not import resolveAdminCredentials from ./admin-credentials',
);
assert.match(
  code,
  /const\s+admin\s*=\s*resolveAdminCredentials\(\s*process\.env\s*\)/,
  'seed.ts must call resolveAdminCredentials(process.env) — anything else decides the gate on a made-up environment',
);

// 3. The gate comes first: before the first database call, and it exits on refusal.
const resolveAt = code.search(/resolveAdminCredentials\(\s*process\.env\s*\)/);
const firstDbCall = code.search(/\bprisma\./);
assert.ok(firstDbCall > 0, 'found no prisma call in seed.ts — the check has nothing to order against');
assert.ok(resolveAt < firstDbCall, 'the credentials are resolved AFTER the first database call: a refusal would leave a half-seeded database');
// The exit has to sit between the refusal test and the "Seeding database" banner: a lazy match against any
// later process.exit(1) (the file ends with one in its .catch) would pass with the refusal exit deleted.
const gateAt = code.search(/if\s*\(\s*!admin\.ok\s*\)/);
const bannerAt = code.indexOf('Seeding database');
const exitAt = gateAt < 0 ? -1 : code.indexOf('process.exit(1)', gateAt);
assert.ok(gateAt > 0 && bannerAt > gateAt, 'seed.ts has no `if (!admin.ok)` refusal ahead of its "Seeding database" banner');
assert.ok(exitAt > gateAt && exitAt < bannerAt, 'a refusal from the resolver does not stop the seed with process.exit(1) before it starts');

// 4. The values that reach the user upsert are the resolved ones.
assert.match(code, /const\s+adminEmail\s*=\s*admin\.email\s*;/, 'adminEmail is not taken from admin.email');
assert.match(code, /bcrypt\.hash\(\s*admin\.password\s*,/, 'the stored hash is not made from admin.password');
assert.match(code, /const\s+passwordHash\s*=\s*await\s+bcrypt\.hash\(/, 'passwordHash is not the bcrypt hash');
assert.match(code, /upsert\(\s*\{\s*where:\s*\{\s*email:\s*adminEmail\s*\}/, 'the user upsert does not look the user up by adminEmail');
assert.match(
  code,
  /create:\s*\{[^}]*\bemail:\s*adminEmail\b[^}]*\bpassword:\s*passwordHash\b/,
  'the upsert\'s create block does not carry adminEmail and passwordHash',
);

console.log('✅ seed.ts takes the admin email and password from resolveAdminCredentials and has no hard-coded default');
