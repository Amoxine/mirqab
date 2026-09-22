import { createPublicKey, type JsonWebKey } from 'node:crypto';

/**
 * The Hydra key set that signs OAuth2 **access** tokens. Hydra keeps id-token signing in a separate
 * set (`hydra.openid.id-token`), and `/.well-known/jwks.json` publishes both — so the public JWKS
 * alone does not say which key a Tyk API should trust. The admin API does.
 */
const ACCESS_TOKEN_KEY_SET = 'hydra.jwt.access-token';

/** Hydra's admin API is in-network and unauthenticated, but it must still not hang a request. */
const ADMIN_TIMEOUT_MS = 5000;

interface Jwk extends JsonWebKey {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
}

/** Can this key verify an RS256 access token? A key set may also hold encryption or EC keys. */
const canVerifyAccessToken = (jwk: Jwk): boolean =>
  jwk.kty === 'RSA' && (jwk.use === undefined || jwk.use === 'sig') && (jwk.alg ?? 'RS256') === 'RS256';

/**
 * Hydra's access-token signing key as a base64-encoded PEM, which is what Tyk's `jwt_source` wants.
 *
 * **Why a pinned key and not a JWKS URL.** Tyk v5.15.0 honours `jwt_jwks_uris` only for OAS API
 * definitions (`getSecretToVerifySignature`: `len(config.JWTJwksURIs) > 0 && config.IsOAS`), and the
 * classic-definition path that does take a URL in `jwt_source` serves exactly one request per
 * gateway start before its JWKS cache read breaks and every later request 403s with
 * "JWKS source decode failed: <url> is not a base64 string". Both reproduced on v5.15.0. A
 * base64 PEM is the one form that verifies reliably (6/6 requests, across reloads).
 *
 * **Which key, once there is more than one.** Rotation leaves the set holding both the new and the
 * retired key, and a JWK carries no `created_at` or "active" marker — the ONLY signal the admin API
 * gives is the order of the set, so pinning the wrong element would 401 every data-plane caller.
 * Hydra returns the set newest-first and itself signs with the first usable key it finds, so the
 * first match here is the current signer. Verified on v26.2.0 against a throwaway key set: three
 * keys created in the order A, B, C came back C, B, A (i.e. `created_at DESC`).
 *
 * ponytail: the ceiling is key rotation — after rotating Hydra's access-token key, every OAUTH API
 * must be re-synced (`POST /apis/:id/sync`) before tokens signed by the new key are accepted, and
 * tokens signed by the retired key are refused from that moment (Tyk verifies against one pinned
 * key, so the two cannot overlap). Hydra does not rotate on its own, so this is an operator action,
 * not a background event. Move to `jwt_jwks_uris` once these APIs are defined as OAS, or once the
 * classic URL path is fixed — a JWKS is selected by `kid` and makes both problems go away.
 */
export async function fetchAccessTokenSigningKey(adminUrl: string): Promise<string> {
  const response = await fetch(new URL(`/admin/keys/${ACCESS_TOKEN_KEY_SET}`, adminUrl), {
    signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Could not read the OAuth2 signing key (HTTP ${String(response.status)})`);
  }

  const { keys } = (await response.json()) as { keys?: Jwk[] };
  // First usable key = newest = the one Hydra is signing with; see the note above.
  const key = keys?.find(canVerifyAccessToken);

  if (!key) {
    throw new Error('The OAuth2 provider published no RS256 signing key');
  }

  const pem = createPublicKey({ key, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();

  return Buffer.from(pem).toString('base64');
}
