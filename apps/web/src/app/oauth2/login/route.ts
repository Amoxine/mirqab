import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { prisma } from '@open-gateway/database';
import type { AcceptOAuth2LoginRequest } from '@ory/client-fetch';
import { APP_URL, hydraAdmin, oauthError } from '@/lib/hydra-admin';
import { kratosServer } from '@/lib/kratos-server';
import { KRATOS_PUBLIC_URL } from '@/lib/kratos-client';
import { recordAuditLog } from '@/lib/audit-log';

/** Hydra "remember this browser" duration for the login session — mirrors Kratos's own session lifespan (24h, infra/ory/kratos/kratos.yml). */
const REMEMBER_FOR_SECONDS = 24 * 60 * 60;

/** Hydra's accept/reject calls throw on a stale or replayed challenge — which a back button or a
 * double submit produces routinely — so every one of them lands on the error page, not a 500. */
async function acceptLogin(
  loginChallenge: string,
  body: AcceptOAuth2LoginRequest,
  ipAddress: string | null,
): Promise<NextResponse> {
  const accepted = await hydraAdmin
    .acceptOAuth2LoginRequest({ loginChallenge, acceptOAuth2LoginRequest: body })
    .catch(() => null);
  if (!accepted) return oauthError('login_accept_failed');

  // The one place a login actually succeeds — both the "Hydra remembers this browser" fast path and
  // the full Kratos-session path call this with a confirmed subject (Postgres User.id).
  if (typeof body.subject === 'string') {
    await recordAuditLog({ userId: body.subject, action: 'LOGIN', resource: 'auth', ipAddress });
  }
  return NextResponse.redirect(accepted.redirect_to);
}

/** Best-effort client IP: `X-Forwarded-For`'s first hop, same convention as apps/api (main.ts). */
function clientIp(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

async function rejectLogin(loginChallenge: string, description: string): Promise<NextResponse> {
  const rejected = await hydraAdmin
    .rejectOAuth2LoginRequest({
      loginChallenge,
      rejectOAuth2Request: { error: 'access_denied', error_description: description },
    })
    .catch(() => null);
  return rejected ? NextResponse.redirect(rejected.redirect_to) : oauthError('login_reject_failed');
}

function rejectInactiveAccount(loginChallenge: string): Promise<NextResponse> {
  return rejectLogin(loginChallenge, 'Account is not active');
}

/** Thrown by `resolveOrProvisionUser` when linking would silently retarget a different account —
 * caught in `GET` and turned into a Hydra rejection, never a token. */
class IdentityConflictError extends Error {}

/**
 * Finds the local `User` row for a Kratos identity, or creates one.
 *
 * Postgres `User.id` (not the Kratos identity id) is the Hydra token subject — confirmed by
 * worker-4/WP2 (apps/api/src/modules/auth/strategies/jwt.strategy.ts's `sub` handling) and by
 * `User.kratosIdentityId`'s own comment in schema.prisma. Preferred lookup order, most to least
 * authoritative:
 *  1. `identity.metadata_public.app_user_id` — a direct pointer WP5's import script MAY set (per
 *     WP2's relayed contract); not yet set by the current `migrate-users-to-kratos.ts`, so this
 *     is forward-compatible, not load-bearing today.
 *  2. `kratosIdentityId` — backfilled by that same script for pre-existing users.
 *  3. email — the one trait every path shares; also what (1)/(2) fall back to and then backfill.
 * A brand-new self-service registration matches none of these, so one is provisioned here with
 * zero tenant memberships (the "register -> tenant-less 403" flow the plan expects, not a 401 —
 * see resolveSession, which returns a valid empty-permissions session for a user row with no
 * active tenant).
 *
 * ponytail: `password` is a random, never-used placeholder — Kratos is the only credential store
 * now. `User.password` is already nullable in schema.prisma, so WP7's cleanup is just deleting
 * this field from the create (and eventually the column), not a migration to relax it.
 */
async function resolveOrProvisionUser(
  identity: { id: string; metadata_public?: unknown; verifiable_addresses?: { value: string; verified: boolean }[] },
  email: string,
  name: string,
): Promise<{ id: string; status: string }> {
  const kratosIdentityId = identity.id;
  const metadataUserId =
    typeof identity.metadata_public === 'object' &&
    identity.metadata_public !== null &&
    typeof (identity.metadata_public as { app_user_id?: unknown }).app_user_id === 'string'
      ? (identity.metadata_public as { app_user_id: string }).app_user_id
      : null;

  const byAppUserId = metadataUserId
    ? await prisma.user.findUnique({ where: { id: metadataUserId }, select: { id: true, status: true } })
    : null;
  if (byAppUserId) return byAppUserId;

  const byKratosId = await prisma.user.findUnique({
    where: { kratosIdentityId },
    select: { id: true, status: true },
  });
  if (byKratosId) return byKratosId;

  // Neither lookup above matched, so any row this email resolves to was NOT created for this
  // identity. Read first rather than blind-upsert: binding it unconditionally (the previous
  // design) let anyone who registers an unclaimed email retarget whatever User.id that email
  // belongs to — including a super_admin row whose own Kratos identity was since deleted (the
  // normal way this app offboards someone, since there's no user-deletion path). Two things must
  // both hold before we touch an existing row: no OTHER identity already claims it, and this
  // identity has actually verified the address, not just typed it at registration.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, status: true, kratosIdentityId: true },
  });

  if (existing) {
    if (existing.kratosIdentityId !== null && existing.kratosIdentityId !== kratosIdentityId) {
      throw new IdentityConflictError(`email ${email} already bound to a different identity`);
    }
    const verified = identity.verifiable_addresses?.some((a) => a.value === email && a.verified) ?? false;
    if (!verified) {
      throw new IdentityConflictError(`email ${email} not verified on this identity`);
    }
    return prisma.user.update({
      where: { id: existing.id },
      data: { kratosIdentityId },
      select: { id: true, status: true },
    });
  }

  // Brand new email: create, tolerating the race where a concurrent first-login for the same
  // address wins first. The loser lands right back in the `existing` branch above on retry, which
  // is safe here because kratosIdentityId will already equal the winner's — i.e. this identity's.
  try {
    return await prisma.user.create({
      data: {
        email,
        name: name || email,
        password: randomBytes(32).toString('hex'),
        status: 'ACTIVE',
        kratosIdentityId,
      },
      select: { id: true, status: true },
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'P2002') {
      return resolveOrProvisionUser(identity, email, name);
    }
    throw err;
  }
}

/**
 * Hydra's `urls.login` target (infra/ory/hydra/hydra.yml). Hydra redirects here with a
 * `login_challenge` whenever it needs to know who the browser is — this route must work with NO
 * existing dashboard session (that's the whole point).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const loginChallenge = request.nextUrl.searchParams.get('login_challenge');
  if (!loginChallenge) {
    return oauthError('missing_login_challenge');
  }

  const loginRequest = await hydraAdmin.getOAuth2LoginRequest({ loginChallenge }).catch(() => null);
  if (!loginRequest) {
    return oauthError('invalid_login_challenge');
  }

  // Hydra already remembers this browser (a prior `remember: true` accept) — nothing to ask Kratos.
  if (loginRequest.skip) {
    // The accept below sets `remember_for` 24h, which makes THIS the path a returning user takes,
    // not a rare one — so it needs the same account-status gate as the Kratos path further down.
    // Without it, suspending a user has no effect on their sign-ins until the remember window
    // lapses. (`subject` is the Postgres `User.id`; see resolveOrProvisionUser.)
    const remembered = await prisma.user.findUnique({
      where: { id: loginRequest.subject },
      select: { status: true },
    });
    if (remembered?.status !== 'ACTIVE') {
      return rejectInactiveAccount(loginChallenge);
    }
    return acceptLogin(loginChallenge, { subject: loginRequest.subject }, clientIp(request));
  }

  const cookieHeader = request.headers.get('cookie') ?? undefined;
  const session = await kratosServer.toSession({ cookie: cookieHeader }).catch(() => null);

  if (!session?.identity) {
    // No Kratos session: send the browser to Kratos's own flow init, with the challenge riding in
    // `return_to` so Kratos hands the browser back HERE once a session exists.
    //
    // The challenge is deliberately NOT passed as `?login_challenge=`. Kratos only tolerates that
    // parameter when `oauth2_provider.url` is configured (500 "refusing to parse login_challenge"
    // otherwise), and once it is, Kratos accepts the login request against Hydra *itself*, using the
    // Kratos identity id as the subject. Everything downstream needs the Postgres `User.id` instead
    // — jwt.strategy.ts resolves the session by it, and ApiKey.userId/AuditLog.userId are FKs to it
    // — so that path issues a token the API rejects with 401 and never provisions a User row at all.
    // Going through `return_to` keeps the accept below, where resolveOrProvisionUser sets the right
    // subject.
    const kratosLoginUrl = new URL('/self-service/login/browser', KRATOS_PUBLIC_URL);
    const returnTo = new URL('/oauth2/login', APP_URL);
    returnTo.searchParams.set('login_challenge', loginChallenge);
    kratosLoginUrl.searchParams.set('return_to', returnTo.toString());
    return NextResponse.redirect(kratosLoginUrl);
  }

  const traits = session.identity.traits as { email?: unknown; name?: unknown } | null;
  // Lowercased once, here: Kratos keeps `traits.email` as typed but lowercases
  // `verifiable_addresses[].value`, and `User.email` is a case-sensitive unique column — so every
  // lookup, create and verified-address check below needs this one canonical form.
  const email = typeof traits?.email === 'string' ? traits.email.toLowerCase() : null;
  if (!email) {
    return oauthError('identity_missing_email');
  }

  let user: { id: string; status: string };
  try {
    user = await resolveOrProvisionUser(
      session.identity,
      email,
      typeof traits?.name === 'string' ? traits.name : '',
    );
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      return rejectLogin(loginChallenge, 'Could not verify this account. Contact an administrator.');
    }
    throw err;
  }
  if (user.status !== 'ACTIVE') {
    return rejectInactiveAccount(loginChallenge);
  }

  return acceptLogin(
    loginChallenge,
    { subject: user.id, remember: true, remember_for: REMEMBER_FOR_SECONDS, context: { email } },
    clientIp(request),
  );
}
