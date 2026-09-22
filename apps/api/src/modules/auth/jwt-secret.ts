/**
 * DEPRECATED — dead since the Ory cutover (WP2): no caller left. This app signs nothing, so there is
 * no JWT_SECRET to assert; strategies/jwt.strategy.ts verifies Hydra-issued tokens against Hydra's
 * JWKS instead. Kept for history, not deleted (WP7 decision, 2026-09-20); safe to delete in a future
 * pass along with services/token.service.ts.
 */

/**
 * Placeholders that ship in the repo. Whoever left one in place has not chosen a secret, so tokens
 * signed with it are forgeable by anyone who has read the repo.
 */
const PLACEHOLDER_SECRETS = new Set([
  'change-me',
  'change-this-to-a-strong-random-secret',
]);

/** 256 bits of hex/base64 is the floor for an HS256 signing key. */
const MIN_SECRET_LENGTH = 32;

/**
 * Validates JWT_SECRET at boot. Used by both AuthModule (signing) and JwtStrategy (verifying), so
 * the two cannot drift apart.
 *
 * The length floor is skipped when NODE_ENV=test: CI signs with a short throwaway secret. The
 * placeholder check is NOT skipped — a known constant is never acceptable, test run or not.
 *
 * @throws Error when the secret is missing, a repo placeholder, or too short outside tests.
 */
export function assertJwtSecret(
  secret: string | undefined,
  nodeEnv: string | undefined,
): string {
  if (!secret) {
    throw new Error('JWT_SECRET must be set to a strong random value');
  }

  if (PLACEHOLDER_SECRETS.has(secret)) {
    throw new Error(
      `JWT_SECRET is still the placeholder "${secret}" — generate one with \`openssl rand -hex 32\``,
    );
  }

  if (nodeEnv !== 'test' && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${String(MIN_SECRET_LENGTH)} characters (got ${String(secret.length)})`,
    );
  }

  return secret;
}
