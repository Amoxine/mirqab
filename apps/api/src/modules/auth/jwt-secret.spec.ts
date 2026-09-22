/**
 * DEPRECATED — covers jwt-secret.ts, itself dead since the Ory cutover (WP2). Still green, so it
 * stays green; it guards nothing reachable. Kept for history, not deleted (WP7 decision,
 * 2026-09-20); delete it in the same pass as the module it covers.
 */
import { assertJwtSecret } from './jwt-secret';

const STRONG = 'f2b1c0a9e8d7f6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2b1';

describe('assertJwtSecret', () => {
  it('returns a strong secret unchanged', () => {
    expect(assertJwtSecret(STRONG, 'production')).toBe(STRONG);
  });

  it('rejects a missing secret', () => {
    expect(() => assertJwtSecret(undefined, 'production')).toThrow('JWT_SECRET must be set');
    expect(() => assertJwtSecret('', 'production')).toThrow('JWT_SECRET must be set');
  });

  // Only 'change-me' was rejected before, so the value shipped in infra/docker-compose.yml and
  // .env.example signed real tokens.
  it.each([['change-me'], ['change-this-to-a-strong-random-secret']])(
    'rejects the repo placeholder %s in every environment',
    (placeholder) => {
      expect(() => assertJwtSecret(placeholder, 'production')).toThrow('still the placeholder');
      expect(() => assertJwtSecret(placeholder, 'development')).toThrow('still the placeholder');
      expect(() => assertJwtSecret(placeholder, 'test')).toThrow('still the placeholder');
    },
  );

  it('rejects a secret shorter than 32 characters outside tests', () => {
    expect(() => assertJwtSecret('short-secret', 'production')).toThrow('at least 32 characters');
    expect(() => assertJwtSecret('short-secret', 'development')).toThrow('at least 32 characters');
    expect(() => assertJwtSecret('short-secret', undefined)).toThrow('at least 32 characters');
  });

  // CI signs with a short throwaway secret (NODE_ENV=test, JWT_SECRET=test-secret-for-ci-only).
  it('allows a short secret when NODE_ENV=test', () => {
    expect(assertJwtSecret('test-secret-for-ci-only', 'test')).toBe('test-secret-for-ci-only');
  });

  it('accepts a 32-character secret exactly', () => {
    const exactly32 = 'a'.repeat(32);

    expect(assertJwtSecret(exactly32, 'production')).toBe(exactly32);
  });
});
