import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Reachable with no dashboard session by design — Kratos/Hydra's own self-service and OAuth2 flows,
 * plus `/locale` (the language switcher's cookie write): a pre-login visitor on `/auth/login` must be
 * able to switch language too, and the cookie it sets carries no auth/tenant meaning either way. */
const PUBLIC_PREFIXES = ['/auth', '/oauth2', '/locale'];

/**
 * Server-side gate for `(dashboard)/**` — today (before this file) there is none: `dashboard/
 * layout.tsx` renders for anyone and only a client-side 401 eventually redirects. Deny-by-default,
 * allow-list the public prefixes, since dashboard routes include `/` itself (route groups don't
 * appear in the URL) and can't be matched by a single path prefix.
 *
 * ponytail: this only checks that `access_token` is PRESENT, not that it's valid/unexpired — full
 * verification (signature, issuer, expiry against Hydra's JWKS) happens on the actual API call and
 * 401s there if the cookie is stale; middleware's job is just to stop rendering a protected page for
 * a visitor who is obviously signed out, not to duplicate the API's authorization guard.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  // Segment-aware, not a bare `startsWith`: `/authors` must not be swept in as public just because
  // it shares a prefix with `/auth`.
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }

  if (request.cookies.get('access_token')) {
    return NextResponse.next();
  }

  const authorizeUrl = new URL('/oauth2/authorize', request.url);
  authorizeUrl.searchParams.set('return_to', pathname + request.nextUrl.search);
  return NextResponse.redirect(authorizeUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
