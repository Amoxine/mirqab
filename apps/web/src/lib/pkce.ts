import { createHash, randomBytes } from 'node:crypto';

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636 code_verifier: 43-128 chars of unreserved characters. 32 random bytes -> 43 base64url chars. */
export const generateCodeVerifier = (): string => base64url(randomBytes(32));

/** S256 code_challenge for a given verifier. */
export const generateCodeChallenge = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest());

/** Opaque CSRF token for the OAuth2 `state` parameter. */
export const generateState = (): string => base64url(randomBytes(16));
