import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { hydraAdmin } from '@/lib/hydra-admin';
import { kratosServer } from '@/lib/kratos-server';
import { ACCESS_TOKEN_COOKIE, clearSessionCookies } from '@/lib/oauth-cookies';
import { recordAuditLog } from '@/lib/audit-log';

/**
 * The dashboard's own "Log out" action (`components/layout/header.tsx`) — distinct from
 * `/oauth2/logout`, which only handles Hydra's front-channel RP-initiated logout. This:
 *  1. clears the dashboard's own session cookies (kills API access immediately),
 *  2. best-effort revokes Hydra's "remembered browser" login session, so the next
 *     `/oauth2/authorize` can't silently skip straight back to a login the user just ended,
 *  3. hands back a Kratos logout URL for the client to navigate to, which ends the Kratos session
 *     too and lands on `/auth/login` (kratos.yml's `flows.logout.after.default_browser_return_url`).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Whose sessions get revoked must come from a VERIFIED source. Introspection is Hydra itself
  // confirming the caller holds a live, unrevoked token for that subject; an unverified JWT decode
  // checks nothing — anyone could set an unsigned `{"sub":"<someone else's user id>"}` cookie and
  // end that user's sessions. `sub` is the Postgres `User.id`, the subject /oauth2/login accepts
  // with — see that route.
  const token = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value ?? '';
  const introspected = token ? await hydraAdmin.introspectOAuth2Token({ token }).catch(() => null) : null;
  if (introspected?.active === true && introspected.sub !== undefined) {
    await hydraAdmin.revokeOAuth2LoginSessions({ subject: introspected.sub }).catch(() => undefined);
    // Verified logout only: introspected.sub is Hydra confirming the caller held a live token for
    // that subject, same verification bar as the revoke call right above.
    const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    await recordAuditLog({ userId: introspected.sub, action: 'LOGOUT', resource: 'auth', ipAddress });
  }

  const cookieHeader = request.headers.get('cookie') ?? undefined;
  const logoutFlow = await kratosServer.createBrowserLogoutFlow({ cookie: cookieHeader }).catch(() => null);

  const res = NextResponse.json({ kratosLogoutUrl: logoutFlow?.logout_url ?? null });
  clearSessionCookies(res);
  return res;
}
