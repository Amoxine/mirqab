import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  DASHBOARD_CLIENT_ID,
  DASHBOARD_REDIRECT_URI,
  DASHBOARD_SCOPE,
  HYDRA_BROWSER_URL,
  ensureDashboardClient,
  sanitizeReturnTo,
} from '@/lib/hydra-admin';
import { generateCodeChallenge, generateCodeVerifier, generateState } from '@/lib/pkce';
import { setOAuthFlowCookie } from '@/lib/oauth-cookies';

/**
 * Entry point for "sign in": starts the dashboard's own OAuth2 authorization_code+PKCE flow
 * against Hydra. `middleware.ts` sends every unauthenticated dashboard request here; a "Sign in"
 * link can also point here directly.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  await ensureDashboardClient();

  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get('return_to'));
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  const authorizeUrl = new URL('/oauth2/auth', HYDRA_BROWSER_URL);
  authorizeUrl.searchParams.set('client_id', DASHBOARD_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', DASHBOARD_SCOPE);
  authorizeUrl.searchParams.set('redirect_uri', DASHBOARD_REDIRECT_URI);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', generateCodeChallenge(codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const res = NextResponse.redirect(authorizeUrl);
  setOAuthFlowCookie(res, { state, codeVerifier, returnTo });
  return res;
}
