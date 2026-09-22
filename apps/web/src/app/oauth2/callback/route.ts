import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { APP_URL, DASHBOARD_REDIRECT_URI, exchangeToken, oauthError } from '@/lib/hydra-admin';
import { OAUTH_FLOW_COOKIE, clearOAuthFlowCookie, readOAuthFlowCookie, setSessionCookies } from '@/lib/oauth-cookies';

/**
 * The dashboard OAuth2 client's `redirect_uri` — Hydra lands here after login+consent are accepted,
 * with an authorization code to exchange for the session's tokens.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const flow = readOAuthFlowCookie(request.cookies.get(OAUTH_FLOW_COOKIE)?.value);

  // `flow?.state !== state` catches both a missing cookie (expired, or a CSRF attempt with no
  // cookie at all) and a mismatched one. Checked BEFORE the `!code` branch below, and separately
  // from it: state matching is what proves this response is genuinely Hydra's, not forged — once
  // that holds, an absent `code` means Hydra rejected the request (login/consent denial, an
  // inactive account, our own IdentityConflictError) rather than a CSRF attempt, and its actual
  // `error`/`error_description` should reach the user instead of a generic "invalid_state" that
  // makes every rejection reason indistinguishable from a forged callback.
  if (!state || flow?.state !== state) {
    return oauthError('invalid_state');
  }
  if (!code) {
    return oauthError(searchParams.get('error') ?? 'access_denied', searchParams.get('error_description') ?? undefined);
  }

  const result = await exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: DASHBOARD_REDIRECT_URI,
    code_verifier: flow.codeVerifier,
  });
  if (!result.ok) {
    return oauthError('token_exchange_failed');
  }

  // `flow.returnTo` is a same-origin path (sanitised both when written and when read), and APP_URL
  // rather than `request.url` is what it must resolve against — see APP_URL in lib/hydra-admin.ts.
  const res = NextResponse.redirect(new URL(flow.returnTo, APP_URL));
  setSessionCookies(res, result.tokens);
  clearOAuthFlowCookie(res);
  return res;
}
