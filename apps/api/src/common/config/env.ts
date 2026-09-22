/**
 * COOKIE_SECURE ('true' | 'false', case-insensitive) overrides the session cookies' `Secure` flag.
 * Unset or anything else falls back to NODE_ENV === 'production', so a compose stack that runs
 * NODE_ENV=development behind TLS can still opt in.
 */
export function parseCookieSecure(raw: string | undefined, nodeEnv: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return nodeEnv === 'production';
}

/**
 * TRUST_PROXY_HOPS is the number of reverse proxies in front of the API, for Express `trust proxy`.
 * 0 (the default) ignores X-Forwarded-For, so the throttler keys on the socket address. Never
 * `true`: that trusts the whole header and lets any client pick its own throttle bucket.
 * A non-integer or negative value falls back to 0 and is flagged so the caller can warn.
 */
export function parseTrustProxyHops(raw: string | undefined): { hops: number; invalid: boolean } {
  const value = raw?.trim();
  if (!value) return { hops: 0, invalid: false };
  return /^\d+$/.test(value)
    ? { hops: Number(value), invalid: false }
    : { hops: 0, invalid: true };
}
