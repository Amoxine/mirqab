import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { DASHBOARD_CLIENT_ID, hydraAdmin, oauthError } from '@/lib/hydra-admin';

/**
 * Hydra's `urls.consent` target. The dashboard client is first-party (`skip_consent: true`, see
 * `ensureDashboardClient`), so Hydra should never route it here at all — and any OTHER client that
 * does arrive is by definition one nobody has decided to grant anything to, so it is rejected
 * rather than silently rubber-stamped. Without that check this route is a blanket auto-approval
 * for every future authorization_code client.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const consentChallenge = request.nextUrl.searchParams.get('consent_challenge');
  if (!consentChallenge) {
    return oauthError('missing_consent_challenge');
  }

  const consentRequest = await hydraAdmin.getOAuth2ConsentRequest({ consentChallenge }).catch(() => null);
  if (!consentRequest) {
    return oauthError('invalid_consent_challenge');
  }

  if (consentRequest.client?.client_id !== DASHBOARD_CLIENT_ID) {
    const rejected = await hydraAdmin
      .rejectOAuth2ConsentRequest({
        consentChallenge,
        rejectOAuth2Request: {
          error: 'access_denied',
          error_description: 'This client has no consent flow. Add one before granting it scopes.',
        },
      })
      .catch(() => null);
    return rejected ? NextResponse.redirect(rejected.redirect_to) : oauthError('consent_rejection_failed');
  }

  const accepted = await hydraAdmin
    .acceptOAuth2ConsentRequest({
      consentChallenge,
      acceptOAuth2ConsentRequest: {
        grant_scope: consentRequest.requested_scope ?? [],
        grant_access_token_audience: consentRequest.requested_access_token_audience ?? [],
        remember: true,
        remember_for: 24 * 60 * 60,
      },
    })
    .catch(() => null);
  if (!accepted) {
    // Expired/already-used challenge (double submit, back button) or Hydra down — the error page,
    // never a raw 500 mid-flow.
    return oauthError('consent_accept_failed');
  }
  return NextResponse.redirect(accepted.redirect_to);
}
