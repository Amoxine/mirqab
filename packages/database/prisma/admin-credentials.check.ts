/**
 * Pins `resolveAdminCredentials`, the gate in front of the seeded super_admin account.
 *
 * What it protects: the seed used to hard-code `admin@opengateway.io` / `Admin123!` everywhere. The
 * gate now fails CLOSED: the development defaults are handed out only when NODE_ENV is exactly
 * `development` or `test` (after trim and lowercase) AND neither ADMIN_EMAIL nor ADMIN_PASSWORD is
 * set. Everything else — unset, empty, `Production`, ` production`, `prod`, `staging`, a typo —
 * takes the strict path and needs real credentials, because the failure this guards is a production
 * deployment whose one all-permissions account has a password published in this repository, and the
 * way that happens is a NODE_ENV that does not match a literal string. A supplied ADMIN_* value is
 * never ignored: it is validated strictly in every environment.
 *
 * Every refusal case below must FAIL the gate; the pass cases prove it is not simply refusing
 * everything. Imports ONLY ./admin-credentials (pure, no I/O) — never ./seed, which runs `main()`
 * against DATABASE_URL on import. (That the SEED itself refuses before touching a database is
 * checked separately, in ./seed-refusal.check.ts.)
 *
 * No test framework in this package — same convention as `prisma/permissions.check.ts`: plain
 * assertions, tsx, non-zero exit on throw. Wired into `pnpm --filter @open-gateway/database test`.
 */
import assert from 'node:assert/strict';
import {
  DEV_ADMIN_EMAIL,
  DEV_ADMIN_PASSWORD,
  MAX_ADMIN_PASSWORD_BYTES,
  MIN_PROD_ADMIN_PASSWORD_LENGTH,
  resolveAdminCredentials,
  type AdminCredentialsResult,
} from './admin-credentials';

const GOOD_PASSWORD = 'correct-horse-battery-staple';
const GOOD_EMAIL = 'ops@example.test';
const prod = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'production', ...extra });

function refused(result: AdminCredentialsResult, label: string): string[] {
  if (result.ok) assert.fail(`${label}: the gate must refuse, but it accepted`);
  return result.errors;
}

function accepted(result: AdminCredentialsResult, label: string) {
  if (!result.ok) assert.fail(`${label}: the gate must accept, but it refused: ${JSON.stringify(result)}`);
  return result;
}

// ─── the development default: only for a literal development/test with ADMIN_* both unset ───────
for (const NODE_ENV of ['development', 'test', ' Development ', 'TEST']) {
  const dev = accepted(resolveAdminCredentials({ NODE_ENV }), `NODE_ENV=${JSON.stringify(NODE_ENV)}`);
  assert.equal(dev.email, DEV_ADMIN_EMAIL);
  assert.equal(dev.password, DEV_ADMIN_PASSWORD);
  assert.equal(dev.source, 'dev-default');
}

// ─── fail closed: every NODE_ENV that is not literally development/test, ADMIN_* unset ──────────
// This is the bypass list. `Production`, `PRODUCTION`, ` production` and `production\n` all LOOK like
// production to a human and used to fall through to the published password.
const bypasses: (string | undefined)[] = [
  undefined, '', '   ', 'production', 'Production', 'PRODUCTION', ' production', 'production ',
  'production\n', 'prod', 'staging', 'stage', 'dev', 'develop', 'developmen', 'devel0pment', 'local', 'ci',
];
for (const NODE_ENV of bypasses) {
  const text = refused(resolveAdminCredentials({ NODE_ENV }), `NODE_ENV=${JSON.stringify(NODE_ENV)}`).join('\n');
  assert.match(text, /ADMIN_EMAIL/, `NODE_ENV=${JSON.stringify(NODE_ENV)}: must name the missing ADMIN_EMAIL`);
  assert.match(text, /ADMIN_PASSWORD/, 'must name the missing ADMIN_PASSWORD (every check runs, none short-circuits)');
  assert.match(text, /NODE_ENV/, 'must say why no development default applied');
}

// ─── a supplied value is never ignored, in any environment ───────────────────────────────────────
for (const NODE_ENV of ['development', 'test', 'production']) {
  const used = accepted(
    resolveAdminCredentials({ NODE_ENV, ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: GOOD_PASSWORD }),
    `valid ADMIN_* under ${NODE_ENV}`,
  );
  assert.equal(used.email, GOOD_EMAIL, `ADMIN_EMAIL must be used under ${NODE_ENV}, not silently dropped for the default`);
  assert.equal(used.password, GOOD_PASSWORD);
  assert.equal(used.source, 'env');
}
// One of the two set means the default is off the table: the other must be supplied too.
assert.match(
  refused(resolveAdminCredentials({ NODE_ENV: 'development', ADMIN_EMAIL: GOOD_EMAIL }), 'dev, only email').join('\n'),
  /ADMIN_PASSWORD/,
);
assert.match(
  refused(resolveAdminCredentials({ NODE_ENV: 'development', ADMIN_PASSWORD: GOOD_PASSWORD }), 'dev, only password').join('\n'),
  /ADMIN_EMAIL/,
);
// Set-but-empty is "set": an empty line in an .env must not quietly mean "use the default".
refused(resolveAdminCredentials({ NODE_ENV: 'development', ADMIN_EMAIL: '', ADMIN_PASSWORD: '' }), 'dev, both empty');
// One empty on its own (the other unset) is the case that tells "empty counts as set" apart from
// "empty counts as unset": the latter would hand out the default.
assert.match(
  refused(resolveAdminCredentials({ NODE_ENV: 'development', ADMIN_EMAIL: '' }), 'dev, only an empty email').join('\n'),
  /ADMIN_EMAIL is set but empty/,
);
assert.match(
  refused(resolveAdminCredentials({ NODE_ENV: 'test', ADMIN_PASSWORD: '' }), 'test, only an empty password').join('\n'),
  /ADMIN_PASSWORD is set but empty/,
);
refused(resolveAdminCredentials({ NODE_ENV: 'test', ADMIN_EMAIL: '   ', ADMIN_PASSWORD: GOOD_PASSWORD }), 'test, blank email');
// Supplied weak values are refused under dev as well — the strict rules do not depend on NODE_ENV.
refused(
  resolveAdminCredentials({ NODE_ENV: 'development', ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'short' }),
  'dev, short supplied password',
);
refused(
  resolveAdminCredentials({ NODE_ENV: 'development', ADMIN_EMAIL: DEV_ADMIN_EMAIL, ADMIN_PASSWORD: GOOD_PASSWORD }),
  'dev, default email supplied explicitly',
);

// ─── strict rules ──────────────────────────────────────────────────────────────────────────────────
refused(resolveAdminCredentials(prod({ ADMIN_EMAIL: '   ', ADMIN_PASSWORD: '   ' })), 'whitespace-only values');
assert.match(
  refused(resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL })), 'no password').join('\n'),
  /ADMIN_PASSWORD/,
);
assert.match(
  refused(resolveAdminCredentials(prod({ ADMIN_PASSWORD: GOOD_PASSWORD })), 'no email').join('\n'),
  /ADMIN_EMAIL/,
);
assert.match(
  refused(
    resolveAdminCredentials(prod({ ADMIN_EMAIL: DEV_ADMIN_EMAIL, ADMIN_PASSWORD: GOOD_PASSWORD })),
    'dev default email',
  ).join('\n'),
  /dev default/i,
);
refused(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: 'Admin@OpenGateway.IO', ADMIN_PASSWORD: GOOD_PASSWORD })),
  'dev default email, different case',
);
assert.match(
  refused(
    resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: DEV_ADMIN_PASSWORD })),
    'dev default password',
  ).join('\n'),
  /dev default/i,
);
refused(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'x'.repeat(MIN_PROD_ADMIN_PASSWORD_LENGTH - 1) })),
  'password one character too short',
);
refused(resolveAdminCredentials(prod({ ADMIN_EMAIL: 'not-an-email', ADMIN_PASSWORD: GOOD_PASSWORD })), 'email without @');
refused(resolveAdminCredentials(prod({ ADMIN_EMAIL: 'a@b', ADMIN_PASSWORD: GOOD_PASSWORD })), 'email without a dotted domain');
refused(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: ` ${GOOD_PASSWORD}\n` })),
  'password with leading/trailing whitespace (a copy-paste artefact, not a choice)',
);

// ─── bcrypt only reads the first 72 BYTES; the rest of a longer password is silently ignored ─────────
const atLimit = accepted(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'x'.repeat(MAX_ADMIN_PASSWORD_BYTES) })),
  `${String(MAX_ADMIN_PASSWORD_BYTES)}-byte password`,
);
assert.equal(atLimit.password.length, MAX_ADMIN_PASSWORD_BYTES);
assert.match(
  refused(
    resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'x'.repeat(MAX_ADMIN_PASSWORD_BYTES + 1) })),
    '73-byte password',
  ).join('\n'),
  /bytes/,
);
// Multi-byte characters: 'é' is 2 bytes, so the limit is hit at 36 of them, long before 72 characters.
accepted(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'é'.repeat(MAX_ADMIN_PASSWORD_BYTES / 2) })),
  '36 x 2-byte characters = 72 bytes',
);
refused(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'é'.repeat(MAX_ADMIN_PASSWORD_BYTES / 2 + 1) })),
  '37 x 2-byte characters = 74 bytes (only 37 characters)',
);
accepted(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: `${'é'.repeat(35)}xx` })),
  '35 x 2-byte + 2 ASCII = 72 bytes',
);
refused(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: `${'é'.repeat(35)}xxx` })),
  '35 x 2-byte + 3 ASCII = 73 bytes',
);
// The minimum counts characters, not bytes: twelve 2-byte characters are 24 bytes and still 12 long.
accepted(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'é'.repeat(MIN_PROD_ADMIN_PASSWORD_LENGTH) })),
  'minimum length counted in characters',
);

// A refusal must never echo the password it was handed: this goes to container logs. Each message
// that mentions the password is provoked in turn (too short, default, padded, too long) and none may
// quote it.
for (const bad of ['sh0rt-sec', DEV_ADMIN_PASSWORD, ' padded-secret-value ', 'L'.repeat(MAX_ADMIN_PASSWORD_BYTES + 5)]) {
  const text = refused(
    resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: bad })),
    `leak check (${String(bad.length)} chars)`,
  ).join('\n');
  assert.match(text, /ADMIN_PASSWORD/, 'the refusal must be about the password');
  assert.ok(!text.includes(bad.trim()), 'a refusal message must not contain the password');
}

// ─── acceptances ─────────────────────────────────────────────────────────────────────────────────────
const exactlyMin = accepted(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'x'.repeat(MIN_PROD_ADMIN_PASSWORD_LENGTH) })),
  'password of exactly the minimum length',
);
assert.equal(exactlyMin.password.length, MIN_PROD_ADMIN_PASSWORD_LENGTH);

const good = accepted(
  resolveAdminCredentials(prod({ ADMIN_EMAIL: '  Ops.Lead@Example.Test ', ADMIN_PASSWORD: GOOD_PASSWORD })),
  'valid production credentials',
);
assert.equal(good.email, 'ops.lead@example.test', 'email is trimmed and lowercased, matching how the app stores it');
assert.equal(good.password, GOOD_PASSWORD, 'the password is used verbatim');
assert.equal(
  accepted(resolveAdminCredentials(prod({ ADMIN_EMAIL: GOOD_EMAIL, ADMIN_PASSWORD: 'has spaces inside ok' })), 'inner spaces').password,
  'has spaces inside ok',
);

console.log('✅ resolveAdminCredentials: fails closed; the development default needs a literal development/test and no ADMIN_*');
