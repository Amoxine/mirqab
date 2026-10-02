/**
 * Which credentials the seed gives the super_admin account.
 *
 * Kept in its OWN module, like `scripts/migration-candidate.ts`: `seed.ts` runs `main()` against
 * DATABASE_URL on import, so anything that only needs this logic — `admin-credentials.check.ts` —
 * must import it from here. Do not add a PrismaClient, `fetch` or top-level call to this file.
 *
 * FAILS CLOSED. The published development login (admin@opengateway.io / Admin123!) is handed out in
 * exactly one situation: NODE_ENV is literally `development` or `test` (after trim and lowercase)
 * AND neither ADMIN_EMAIL nor ADMIN_PASSWORD is set. Every other situation — NODE_ENV unset, empty,
 * `Production`, ` production`, `prod`, `staging`, a typo — needs credentials the operator chose.
 * The earlier shape, "production is strict, anything else gets the default", failed OPEN: the
 * failure being guarded is a production host whose one all-permissions account carries a password
 * that is public, and it happens through a NODE_ENV that is merely not the literal `production`.
 *
 * A supplied ADMIN_EMAIL or ADMIN_PASSWORD is never ignored: it is used and validated strictly in
 * every environment, development included, because silently seeding the default when the operator
 * asked for something else is the same hole from the other side.
 *
 * The seed stores a bcrypt hash of whatever this returns and `scripts/migrate-users-to-kratos.ts`
 * copies that hash into Kratos, so the same credentials sign in there; there is no second place to
 * set them.
 */
export const DEV_ADMIN_EMAIL = 'admin@opengateway.io';
export const DEV_ADMIN_PASSWORD = 'Admin123!';
export const MIN_PROD_ADMIN_PASSWORD_LENGTH = 12;
/** bcrypt hashes only the first 72 bytes; anything past that is silently ignored. */
export const MAX_ADMIN_PASSWORD_BYTES = 72;

export type AdminCredentialsResult =
  | { ok: true; email: string; password: string; source: 'dev-default' | 'env' }
  | { ok: false; errors: string[] };

// Same shape the app accepts: something, an @, a dotted domain. Not RFC 5322 — a typo catcher.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every problem is collected rather than the first one returned, so fixing a deployment is one
 * attempt and not one per variable. No message contains a password value: they reach container logs.
 */
export function resolveAdminCredentials(env: Record<string, string | undefined>): AdminCredentialsResult {
  const rawNodeEnv = env.NODE_ENV ?? '';
  const nodeEnv = rawNodeEnv.trim().toLowerCase();
  const developmentLike = nodeEnv === 'development' || nodeEnv === 'test';

  // "Set" means defined, empty included: an empty line in an .env must not quietly mean "use the
  // default". That is what separates a deliberate dev seed from an environment nobody configured.
  const emailSupplied = env.ADMIN_EMAIL !== undefined;
  const passwordSupplied = env.ADMIN_PASSWORD !== undefined;

  if (developmentLike && !emailSupplied && !passwordSupplied) {
    return { ok: true, email: DEV_ADMIN_EMAIL, password: DEV_ADMIN_PASSWORD, source: 'dev-default' };
  }

  const errors: string[] = [];

  // Lowercased because the app stores emails that way (User.email) and Kratos matches identifiers
  // on it; the dev-default comparison is therefore case-insensitive too.
  const email = (env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!emailSupplied) {
    errors.push('ADMIN_EMAIL is not set — the email of the first super_admin');
  } else if (email === '') {
    errors.push('ADMIN_EMAIL is set but empty');
  } else if (!EMAIL_SHAPE.test(email)) {
    errors.push('ADMIN_EMAIL is not an email address');
  } else if (email === DEV_ADMIN_EMAIL) {
    errors.push(`ADMIN_EMAIL is the dev default (${DEV_ADMIN_EMAIL}) — use a real operator address`);
  }

  // Not trimmed: spaces inside a passphrase are legitimate. Spaces or a newline at the ends are the
  // signature of a bad copy-paste or a stray `.env` line, and would be hashed in silently.
  const password = env.ADMIN_PASSWORD ?? '';
  const passwordBytes = new TextEncoder().encode(password).length;
  if (!passwordSupplied) {
    errors.push('ADMIN_PASSWORD is not set — the password of the first super_admin');
  } else if (password.trim() === '') {
    errors.push('ADMIN_PASSWORD is set but empty');
  } else if (password !== password.trim()) {
    errors.push('ADMIN_PASSWORD starts or ends with whitespace — a copy-paste artefact, not a password');
  } else if (password === DEV_ADMIN_PASSWORD) {
    errors.push('ADMIN_PASSWORD is the dev default — it is published in this repository');
  } else if (password.length < MIN_PROD_ADMIN_PASSWORD_LENGTH) {
    errors.push(
      `ADMIN_PASSWORD is only ${String(password.length)} characters — use at least ${String(MIN_PROD_ADMIN_PASSWORD_LENGTH)}`,
    );
  } else if (passwordBytes > MAX_ADMIN_PASSWORD_BYTES) {
    errors.push(
      `ADMIN_PASSWORD is ${String(passwordBytes)} bytes — bcrypt only reads the first ${String(MAX_ADMIN_PASSWORD_BYTES)}, ` +
        'so the rest would be silently ignored; use at most that many bytes (a multi-byte character counts as several)',
    );
  }

  // Said once, when the reason the default was refused is the environment itself rather than a bad
  // value: a human reading "Production" cannot see that the gate did not read it as production.
  if (!developmentLike && (!emailSupplied || !passwordSupplied)) {
    errors.push(
      `NODE_ENV is ${JSON.stringify(rawNodeEnv.slice(0, 40))}: no development default applies — only a literal ` +
        '"development" or "test", with ADMIN_EMAIL and ADMIN_PASSWORD both unset, gets one',
    );
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, email, password, source: 'env' };
}
