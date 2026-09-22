import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { hydraAdmin, oauthError } from '@/lib/hydra-admin';
import { clearSessionCookies } from '@/lib/oauth-cookies';

/**
 * Hydra's `urls.logout` target — the RP-initiated (front-channel) logout callback. The dashboard's
 * own "Log out" button doesn't need this (see `/oauth2/session-logout`); this route exists because
 * Hydra requires `urls.logout` to be set and reachable without a session, and would use it if
 * anything ever calls Hydra's `/oauth2/sessions/logout` front-channel endpoint.
 *
 * Every exit clears this app's session cookies, including the failure exits: if we cannot confirm
 * the logout with Hydra, the one thing we can still do is stop honouring the local session.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const logoutChallenge = request.nextUrl.searchParams.get('logout_challenge');
  if (!logoutChallenge) {
    // Same contract as this route's siblings: a mangled challenge is a visible failure, not a
    // redirect to /auth/login that looks like it worked while Hydra's logout request hangs.
    return withClearedSession(oauthError('missing_logout_challenge'));
  }

  const accepted = await hydraAdmin.acceptOAuth2LogoutRequest({ logoutChallenge }).catch(() => null);
  if (!accepted) {
    return withClearedSession(oauthError('logout_failed'));
  }
  return withClearedSession(NextResponse.redirect(accepted.redirect_to));
}

function withClearedSession(res: NextResponse): NextResponse {
  clearSessionCookies(res);
  return res;
}
