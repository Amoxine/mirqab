import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { exchangeToken } from '@/lib/hydra-admin';
import { REFRESH_TOKEN_COOKIE, clearSessionCookies, setSessionCookies } from '@/lib/oauth-cookies';

/**
 * Same-origin refresh target `apps/web/src/lib/refresh-retry.ts` calls on a 401 — Hydra's
 * refresh_token grant, replacing the old Redis-digest rotation. Public client + PKCE, so no secret
 * is needed here either; the refresh token itself is the credential.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return NextResponse.json({ error: 'no_refresh_token' }, { status: 401 });
  }

  const result = await exchangeToken({ grant_type: 'refresh_token', refresh_token: refreshToken });

  if (!result.ok) {
    // Only Hydra actively rejecting the grant ends the session: a spent or revoked refresh token
    // comes back as 400 `invalid_grant` (401 covers client-auth rejection). Anything else — 5xx,
    // 429, or an unreachable Hydra (status 0) — is the server's problem, not the token's, and
    // clearing cookies there would log every active user out for the length of a restart AND throw
    // away a refresh token that is still perfectly good.
    const grantRejected = result.status === 400 || result.status === 401;
    if (!grantRejected) {
      return NextResponse.json({ error: 'refresh_unavailable' }, { status: 503 });
    }
    const res = NextResponse.json({ error: 'refresh_failed' }, { status: 401 });
    clearSessionCookies(res);
    return res;
  }

  const res = NextResponse.json({ ok: true });
  setSessionCookies(res, result.tokens);
  return res;
}
