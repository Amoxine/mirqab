/**
 * Ory Kratos client — the authority for "who is this developer" (WP22).
 *
 * The dashboard's own session goes through Hydra (a Kratos login issues a Hydra-brokered JWT —
 * JwtStrategy verifies that, never a Kratos session directly). The portal has no third-party
 * relying party to issue tokens to, so it skips that whole indirection and reads a Kratos session
 * straight from `/sessions/whoami` — Kratos's own supported way to authenticate a non-browser API
 * caller (`kratos.yml`'s CORS config already allow-lists the `X-Session-Token` header this uses,
 * for exactly this).
 *
 * Deliberately not a Nest provider, matching `keto.ts`'s reasoning: two functions do not need a
 * module. Read per call, not at import: ConfigModule loads infra/.env after this module evaluates.
 */

/** A whoami session, narrowed to what DeveloperAuthGuard reads. */
export interface KratosSession {
  identity: {
    id: string;
    traits: { email?: string; name?: string };
  };
}

/** Same bound as every other Ory admin call in this app (see keto.ts, hydra-admin.service.ts). */
const ORY_TIMEOUT_MS = 5000;

const publicUrl = (): string => process.env.ORY_KRATOS_PUBLIC_URL ?? 'http://kratos:4433';
const adminUrl = (): string => process.env.ORY_KRATOS_ADMIN_URL ?? 'http://kratos:4434';

/** Whatever credential the caller actually sent — forwarded to Kratos exactly as Kratos issued it. */
export interface KratosCredential {
  /** A non-browser API client's session token (`Authorization: Bearer <token>`), Kratos's own header. */
  sessionToken?: string;
  /** A browser's raw `Cookie` header, forwarded as-is — Kratos reads its own cookie out of it. */
  cookieHeader?: string;
}

/**
 * Resolves a forwarded Kratos credential to the identity it belongs to, or `null` for anything
 * that is not a live session — an expired/unknown credential and an unreachable Kratos read the
 * same way here (a 401), because `DeveloperAuthGuard` has one answer for both: reject the request.
 * Only a genuinely unexpected failure (a non-401 error status) throws.
 */
export async function kratosWhoAmI(credential: KratosCredential): Promise<KratosSession | null> {
  if (!credential.sessionToken && !credential.cookieHeader) return null;

  const url = new URL('/sessions/whoami', publicUrl());
  const headers: Record<string, string> = {};
  if (credential.sessionToken) headers['X-Session-Token'] = credential.sessionToken;
  if (credential.cookieHeader) headers.Cookie = credential.cookieHeader;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(ORY_TIMEOUT_MS) });
  } catch {
    return null;
  }

  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`Kratos whoami failed: ${String(response.status)} ${await response.text()}`);
  }

  return (await response.json()) as KratosSession;
}

/** The traits + credentials `POST /admin/identities` accepts for a password-based registration. */
export interface NewIdentity {
  email: string;
  name: string;
  password: string;
}

/** An identity as Kratos's admin API returns it — only the fields this app reads. */
export interface KratosIdentity {
  id: string;
  traits: { email: string; name?: string };
}

/**
 * Creates a Kratos identity via the admin API — the same shortcut `migrate-users-to-kratos.ts` and
 * `kratos-hydra-login.e2e.mjs` already use in place of the self-service registration UI's two-step
 * dance (see that e2e file's header for why). `verifiable_addresses` is set explicitly and
 * unverified so the identity has something for the self-service verification flow
 * (`kratosSendVerificationEmail`) to act on — omitting it left Kratos with no pending address to
 * send a code for, live-verified while wiring the courier for this WP.
 *
 * Throws `ConflictException`-shaped info via a thrown `Error` carrying Kratos's own message when
 * the email is already registered (Kratos enforces one identity per email globally — across the
 * dashboard's Users too, they share this one instance) — the caller maps that to a 409.
 */
export async function kratosCreateIdentity(input: NewIdentity): Promise<KratosIdentity> {
  const response = await fetch(new URL('/admin/identities', adminUrl()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_id: 'default',
      traits: { email: input.email, name: input.name },
      credentials: { password: { config: { password: input.password } } },
      verifiable_addresses: [{ value: input.email, via: 'email', verified: false }],
    }),
    signal: AbortSignal.timeout(ORY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Kratos identity create failed: ${String(response.status)} ${await response.text()}`);
  }

  return (await response.json()) as KratosIdentity;
}

/**
 * Starts (and immediately submits) the self-service email-verification flow for `email` — the
 * courier only ever sends on a live flow submission, not merely because an identity exists with an
 * unverified address (live-verified while wiring the courier for this WP: an admin-created identity
 * with `verifiable_addresses` set sent nothing until this ran). Errors are logged by the caller,
 * never thrown into the registration response: a courier hiccup must not fail a registration that
 * otherwise succeeded — the developer row already exists and email delivery can be retried.
 */
export async function kratosSendVerificationEmail(email: string): Promise<void> {
  const flowRes = await fetch(new URL('/self-service/verification/api', publicUrl()), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(ORY_TIMEOUT_MS),
  });
  if (!flowRes.ok) {
    throw new Error(`Kratos verification flow init failed: ${String(flowRes.status)} ${await flowRes.text()}`);
  }
  const flow = (await flowRes.json()) as { ui: { action: string } };

  // `ui.action` is the browser-facing base_url (https://localhost:33012/...) — reachable from a
  // browser, not from inside this network. Same path and query, against the in-network host instead.
  const action = new URL(flow.ui.action);
  const submitRes = await fetch(new URL(`${action.pathname}${action.search}`, publicUrl()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, method: 'code' }),
    signal: AbortSignal.timeout(ORY_TIMEOUT_MS),
  });
  if (!submitRes.ok) {
    throw new Error(`Kratos verification flow submit failed: ${String(submitRes.status)} ${await submitRes.text()}`);
  }
}
