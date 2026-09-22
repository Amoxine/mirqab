import { createPublicKey, type JsonWebKey } from 'node:crypto';

/**
 * Remote JWKS resolver for Hydra-issued access tokens.
 *
 * Hydra signs with a rotating RSA key and publishes the public half at
 * `<public-url>/.well-known/jwks.json`. node:crypto imports a JWK directly and passport-jwt takes a
 * PEM, so no JWKS library is needed — only a cache keyed by `kid` and a cooldown, so a token
 * carrying an unknown `kid` (a rotated key, or a forged header) cannot turn every request into an
 * upstream fetch.
 */

/**
 * Floor: at most one JWKS fetch per minute, so a token carrying an unknown `kid` (a rotated key, or
 * a forged header) cannot turn every request into an upstream fetch.
 */
const REFETCH_COOLDOWN_MS = 60_000;

/**
 * Ceiling: a key is never trusted longer than this without being re-confirmed against Hydra. This
 * is the revocation bound — a key withdrawn from the JWKS stops verifying within this window.
 */
const MAX_CACHE_AGE_MS = 10 * 60_000;

/** This runs on the token-verification path of every request; it must never hang one. */
const JWKS_TIMEOUT_MS = 5000;

interface Jwk {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
}

let keysByKid = new Map<string, string>();
/** Last fetch ATTEMPT, successful or not — drives the retry floor. */
let lastAttemptAt = 0;
/** Last SUCCESSFUL fetch — drives the cache ceiling. Kept apart from the attempt clock on purpose:
 * if a failed fetch refreshed the ceiling, an unreachable JWKS endpoint would keep a revoked key
 * alive one window at a time, which is the very thing the ceiling exists to bound. */
let lastSuccessAt = 0;
let inFlight: Promise<Map<string, string>> | null = null;

const fetchKeys = async (jwksUri: string): Promise<Map<string, string>> => {
  const response = await fetch(jwksUri, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`JWKS fetch failed: ${String(response.status)}`);
  }

  const { keys } = (await response.json()) as { keys?: Jwk[] };
  const parsed = new Map<string, string>();

  for (const jwk of keys ?? []) {
    // Signing keys only, and only the algorithm the strategy accepts — a JWKS may legitimately
    // carry encryption keys or other algorithms, and none of them may verify an access token.
    const usable =
      jwk.kid !== undefined &&
      jwk.kty === 'RSA' &&
      (jwk.use === undefined || jwk.use === 'sig') &&
      (jwk.alg === undefined || jwk.alg === 'RS256');

    if (!usable || jwk.kid === undefined) continue;

    const pem = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();
    parsed.set(jwk.kid, pem);
  }

  return parsed;
};

/**
 * The PEM for `kid`, bounded by a floor and a ceiling.
 *
 * A cache HIT used to be returned unconditionally, with no expiry at all: a key WITHDRAWN from
 * Hydra's JWKS went on verifying tokens until an unrelated unknown `kid` happened to force a
 * refetch, or the process restarted. That is not self-healing in the case that matters — an
 * attacker holding a compromised key presents only that `kid`, which is always a hit, so they never
 * trigger the fetch that would evict it. On a quiet install the key could verify indefinitely.
 * Withdrawing a key is how a compromised signer is taken out of service, so revocation has to be
 * bounded and deterministic: `MAX_CACHE_AGE_MS` is that bound.
 *
 * Fail-closed, deliberately: once the ceiling passes, a refresh that FAILS rejects the token rather
 * than falling back on the cached key, so a Hydra outage becomes an API outage. Serving a stale key
 * on refresh failure would reopen the same finding — and it would do so in the attacker's favour,
 * since anyone able to keep the JWKS endpoint unreachable could extend a revoked key one window at
 * a time. That is also why the ceiling is measured from the last SUCCESSFUL fetch, not the last
 * attempt. The floor still stands in front of it: an unknown `kid` costs at most one fetch/minute.
 */
export const resolveSigningKey = async (jwksUri: string, kid: string): Promise<string> => {
  const withinCeiling = Date.now() - lastSuccessAt < MAX_CACHE_AGE_MS;
  const cached = withinCeiling ? keysByKid.get(kid) : undefined;
  if (cached !== undefined) return cached;

  if (Date.now() - lastAttemptAt < REFETCH_COOLDOWN_MS) {
    throw new Error(`No JWKS signing key for kid "${kid}"`);
  }

  inFlight ??= fetchKeys(jwksUri);
  try {
    keysByKid = await inFlight;
    lastSuccessAt = Date.now();
  } finally {
    inFlight = null;
    lastAttemptAt = Date.now();
  }

  const key = keysByKid.get(kid);
  if (key === undefined) {
    throw new Error(`No JWKS signing key for kid "${kid}"`);
  }

  return key;
};

/** The `kid` a JWT claims in its header. Nothing else from the header is trusted. */
export const kidOf = (rawJwt: string): string => {
  const [header] = rawJwt.split('.');
  if (!header) {
    throw new Error('Malformed JWT: no header');
  }

  const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { kid?: unknown };
  if (typeof kid !== 'string') {
    throw new Error('Malformed JWT: no kid in header');
  }

  return kid;
};

/** Test seam — the cache is module state, and each spec needs to start from empty. */
export const resetJwksCache = (): void => {
  keysByKid = new Map();
  lastAttemptAt = 0;
  lastSuccessAt = 0;
  inFlight = null;
};
