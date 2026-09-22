import { NextResponse } from 'next/server';
import { Configuration, OAuth2Api, ResponseError } from '@ory/client-fetch';
import { sanitizeToOrigin } from './return-to';

// Server-only: the admin API is unauthenticated, so it must never reach the browser (this module
// has no 'use client' path to it — only route handlers and server components import it).
// In-network default (the web container talks to hydra:4445); override in .env.local for `pnpm dev`
// outside Docker, where `hydra` doesn't resolve.
const configuredAdminUrl = process.env.HYDRA_ADMIN_URL ?? '';
export const HYDRA_ADMIN_URL = configuredAdminUrl === '' ? 'http://hydra:4445' : configuredAdminUrl;

const configuredHydraUrl = process.env.HYDRA_PUBLIC_URL ?? '';
/** Server-to-server calls only (the token exchange in oauth2/callback) — never sent to the browser. */
export const HYDRA_PUBLIC_URL = configuredHydraUrl === '' ? 'http://hydra:4444' : configuredHydraUrl;

// `APP_URL` first, and it is the one to set: Next inlines every `NEXT_PUBLIC_*` read at BUILD time,
// even in server-only code like this module, so `NEXT_PUBLIC_APP_URL` is frozen to whatever was set
// during `next build` and a compose `environment:` entry for it is silently ignored. Verified in the
// built output: `process.env.HYDRA_ADMIN_URL` survives in `.next/server/**`, the prefixed name does
// not. The prefixed name stays as a fallback for anything that does set it at build time.
const runtimeAppUrl = process.env.APP_URL ?? '';
const configuredAppUrl = runtimeAppUrl === '' ? (process.env.NEXT_PUBLIC_APP_URL ?? '') : runtimeAppUrl;
/**
 * This app's BROWSER-facing origin, from config. `request.url` is NOT a substitute: Next derives it
 * from the request's own `Host` header, so it is (a) client-controlled, which makes it worthless as
 * one side of a security comparison, and (b) not guaranteed to equal the exact string a value was
 * registered under. Use APP_URL wherever the result must match a registration byte-for-byte (Hydra
 * `redirect_uris`, Kratos `allowed_return_urls`) or is compared against (`sanitizeReturnTo`).
 * A plain redirect to a relative path can still resolve against `request.url` — that is why the
 * app's other call sites work — it is only these two jobs `request.url` cannot do.
 */
export const APP_URL = configuredAppUrl === '' ? 'http://localhost:33000' : configuredAppUrl;

const configuredHydraBrowserUrl = process.env.NEXT_PUBLIC_HYDRA_URL ?? '';
/** What `/oauth2/authorize` redirects the BROWSER to — always the host-published address, never `hydra:4444`. */
export const HYDRA_BROWSER_URL =
  configuredHydraBrowserUrl === '' ? 'http://localhost:33010' : configuredHydraBrowserUrl;

export const hydraAdmin = new OAuth2Api(new Configuration({ basePath: HYDRA_ADMIN_URL }));

/**
 * Reduces an untrusted `return_to` to a path on THIS origin, or `/`. Thin wrapper over
 * `sanitizeToOrigin` (see `./return-to` for the parser-differential rationale and the idempotency
 * property) bound to `APP_URL` — never `request.url`, see APP_URL's own comment above. Server-only
 * callers keep using this; a `'use client'` component wanting the same check needs
 * `sanitizeClientReturnTo` from `./return-to` instead, since this module is unsafe to bundle for
 * the browser (it instantiates the unauthenticated Hydra admin client).
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  return sanitizeToOrigin(raw, APP_URL);
}

/**
 * The single failure exit for every route in `app/oauth2/**`: the dedicated `/oauth2/error` page.
 * A stale or replayed challenge (back button, refresh mid-flow, double submit) and an unreachable
 * Hydra are normal events in this flow — none of them may surface as Next's generic 500, which
 * leaves the user mid-OAuth2 with no way back.
 */
export function oauthError(code: string, description?: string): NextResponse {
  const url = new URL(`/oauth2/error?error=${encodeURIComponent(code)}`, APP_URL);
  if (description) url.searchParams.set('error_description', description);
  return NextResponse.redirect(url);
}

/** The dashboard's own OAuth2 client id — fixed and idempotent, never Hydra-generated. */
export const DASHBOARD_CLIENT_ID = 'dashboard-web';
export const DASHBOARD_SCOPE = 'openid offline_access';
export const DASHBOARD_REDIRECT_URI = new URL('/oauth2/callback', APP_URL).toString();

let ensured: Promise<void> | null = null;

/**
 * Registers the dashboard's Hydra OAuth2 client on first use, once per server process. Public
 * client (`token_endpoint_auth_method: none`) + PKCE, not confidential: a confidential client's
 * secret would need to survive a server restart (Hydra never returns it again after creation) with
 * nowhere safe to persist it outside `infra/**`'s territory. PKCE removes that problem entirely —
 * nothing secret to lose, and the client is simply re-usable (not re-created) once it exists.
 * `skip_consent`/`skip_logout_consent`: this is the dashboard's own first-party client, so there is
 * no third-party consent screen to show.
 */
export function ensureDashboardClient(): Promise<void> {
  ensured ??= (async () => {
    try {
      await hydraAdmin.getOAuth2Client({ id: DASHBOARD_CLIENT_ID });
      return;
    } catch (err) {
      if (!(err instanceof ResponseError) || err.response.status !== 404) throw err;
    }
    await hydraAdmin.createOAuth2Client({
      oAuth2Client: {
        client_id: DASHBOARD_CLIENT_ID,
        client_name: 'Open Gateway Dashboard',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        redirect_uris: [DASHBOARD_REDIRECT_URI],
        post_logout_redirect_uris: [APP_URL],
        scope: 'openid offline_access',
        skip_consent: true,
        skip_logout_consent: true,
      },
    });
  })().catch((err: unknown) => {
    // A failed bootstrap must not "stick" — the next request should retry, not stay broken forever.
    ensured = null;
    throw err;
  });
  return ensured;
}

export interface HydraTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, from the token response's `expires_in`. */
  accessTokenExpiresIn: number;
}

/** `status` 0 means the token endpoint could not be reached or answered with a body we could not
 * parse — transient, like a 5xx, and specifically NOT evidence that the grant itself is dead. */
export type TokenExchangeResult = { ok: true; tokens: HydraTokens } | { ok: false; status: number };

/**
 * Hydra's token endpoint, for both grants this app uses (`authorization_code` in `/oauth2/callback`
 * and `refresh_token` in `/oauth2/refresh`). Public client + PKCE, so `client_id` is the only client
 * credential there is.
 *
 * Returns a result rather than throwing because the two callers must react differently to *why* it
 * failed: `/oauth2/refresh` may only destroy the session on a grant Hydra actively rejected, not on
 * a Hydra that happened to be restarting.
 */
export async function exchangeToken(params: Record<string, string>): Promise<TokenExchangeResult> {
  try {
    const res = await fetch(new URL('/oauth2/token', HYDRA_PUBLIC_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DASHBOARD_CLIENT_ID, ...params }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return {
      ok: true,
      tokens: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        accessTokenExpiresIn: json.expires_in,
      },
    };
  } catch {
    // ECONNREFUSED/DNS/abort against a restarting Hydra, or a non-JSON 200.
    return { ok: false, status: 0 };
  }
}
