import type { NextResponse } from 'next/server';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './cookie-names';
import { sanitizeReturnTo } from './hydra-admin';
import type { HydraTokens } from './hydra-admin';

/** Same override rule as apps/api's `parseCookieSecure`: COOKIE_SECURE wins in either direction, else NODE_ENV. */
function secureCookie(): boolean {
  const raw = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
/** Short-lived: carries the PKCE verifier + CSRF state + post-login destination across the Hydra redirect chain. */
export const OAUTH_FLOW_COOKIE = 'oauth2_flow';

const baseCookie = {
  httpOnly: true,
  secure: secureCookie(),
  sameSite: 'lax' as const,
  path: '/',
};

export interface OAuthFlowState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

export function setSessionCookies(res: NextResponse, tokens: HydraTokens): void {
  res.cookies.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, { ...baseCookie, maxAge: tokens.accessTokenExpiresIn });
  if (tokens.refreshToken) {
    // Outlives the access token it renews — infra/ory/hydra/hydra.yml's ttl.refresh_token is 720h.
    res.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, { ...baseCookie, maxAge: 60 * 60 * 720 });
  }
}

export function clearSessionCookies(res: NextResponse): void {
  res.cookies.set(ACCESS_TOKEN_COOKIE, '', { ...baseCookie, maxAge: 0 });
  res.cookies.set(REFRESH_TOKEN_COOKIE, '', { ...baseCookie, maxAge: 0 });
}

export function setOAuthFlowCookie(res: NextResponse, flow: OAuthFlowState): void {
  // 10m: matches Hydra's ttl.auth_code, the shortest-lived thing this cookie needs to outlive.
  res.cookies.set(OAUTH_FLOW_COOKIE, JSON.stringify(flow), { ...baseCookie, path: '/oauth2', maxAge: 600 });
}

export function clearOAuthFlowCookie(res: NextResponse): void {
  res.cookies.set(OAUTH_FLOW_COOKIE, '', { ...baseCookie, path: '/oauth2', maxAge: 0 });
}

export function readOAuthFlowCookie(raw: string | undefined): OAuthFlowState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as OAuthFlowState).state === 'string' &&
      typeof (parsed as OAuthFlowState).codeVerifier === 'string' &&
      typeof (parsed as OAuthFlowState).returnTo === 'string'
    ) {
      // Re-sanitised on the way out, not just on the way in: this value was last seen by the
      // browser, and `/oauth2/callback` redirects to it. Validating at the read boundary means no
      // future writer of this cookie can reintroduce the open redirect.
      return { ...(parsed as OAuthFlowState), returnTo: sanitizeReturnTo((parsed as OAuthFlowState).returnTo) };
    }
    return null;
  } catch {
    return null;
  }
}
