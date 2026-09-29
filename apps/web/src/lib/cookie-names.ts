/**
 * Session cookie names. Prefixed because browsers share cookies across ports: an unprefixed
 * `access_token` on localhost is the same cookie other apps (e.g. qbus) use, so each login would
 * overwrite the other's session. Also read by `apps/api` (JwtStrategy) — change both together.
 */
export const ACCESS_TOKEN_COOKIE = 'mq_access_token';
export const REFRESH_TOKEN_COOKIE = 'mq_refresh_token';
