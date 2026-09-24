/**
 * End-to-end check of the real login path this session's Ory cutover introduced: Kratos
 * self-service login -> Hydra authorization_code+PKCE -> apps/web's oauth2/* routes -> session
 * cookie -> GET /auth/me -> tenant-less 403 on a tenant-scoped route. None of this is covered by
 * apps/api/test/e2e/auth.e2e.spec.ts (that suite only checks the 401-with-no-token case) or by
 * oauth2-clients.e2e.mjs next door (that one drives the data-plane client_credentials grant, not a
 * user login).
 *
 * Registration is done via Kratos's ADMIN API (same pattern as
 * packages/database/scripts/migrate-users-to-kratos.ts), not the self-service registration UI.
 * That flow is a genuine two-step dance (confirmed with fix-web-kratos-core, not a bug): step 1
 * submits only `traits.*` via `method: profile` and gets back HTTP 400 + `state: choose_method`
 * ("Please choose a credential to authenticate yourself with"), and only THAT response's `ui`
 * carries the password node — step 1's response has none, by design. Driving it here would mean
 * reproducing that two-step exchange for no benefit: self-service registration also has no
 * `session` hook configured, so it doesn't log the browser in either way — a login still has to
 * follow. Admin-API creation gets straight to the state this test actually needs (an identity with
 * a password credential) and lets the rest of the file focus on what it exists to cover: Kratos
 * LOGIN -> Hydra -> dashboard callback -> session cookie -> /auth/me -> tenant-scoped 403.
 *
 * Deliberately NOT a Playwright spec: the flow spans four services on different ports
 * (web/hydra/kratos/api, all host-published per infra/docker-compose.yml) with cookies that need to
 * travel across all of them exactly like a browser's cookie jar would (RFC 6265 cookies are scoped
 * by host, not port, which is what makes this dev setup's multi-port-on-localhost login work for a
 * real browser at all) — a hand-rolled jar + manual redirect-follow over plain `fetch` says that
 * directly, where a Playwright `request` fixture bound to one `baseURL` would not.
 *
 * This is also the POST-DEPLOY check for `web` — run it after every redeploy of that container. The
 * WP21 regression (a rebuilt web image whose Prisma engine sat where `/oauth2/login` did not look)
 * left `/` and the health probe answering while every login returned 500, so nothing short of a real
 * login notices it; step 3's "lands back on the dashboard" is the check that turns that 500 red.
 *
 * Requires the full stack up (`docker compose -f infra/docker-compose.yml ps` — api, web, hydra,
 * kratos, keto, postgres all healthy) and DATABASE_URL pointing at the HOST-published Postgres
 * (compose's own DATABASE_URL uses the in-network `postgres` hostname, which does not resolve here).
 *
 * Defaults target the TLS edge (https, host-published ports). The edge's CA is git-ignored and not in
 * the system trust store, so the package script points NODE_EXTRA_CA_CERTS at `infra/edge/root.crt`
 * (see infra/edge/README.md for how to export it). Against a plain-http dev stack, override the
 * URLs: APP_URL, KRATOS_PUBLIC_URL, HYDRA_PUBLIC_URL, API_URL (and KRATOS_ADMIN_URL).
 *
 * It creates a throwaway identity + User and removes both. Its LOGIN audit row is deliberately LEFT
 * (audit rows are not ours to delete on a shared stack) and its id is printed; the row's user_id
 * reads NULL afterwards because audit_logs.user_id is ON DELETE SET NULL.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:login
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma } = require('@open-gateway/database');

const WEB_URL = process.env.APP_URL ?? 'https://localhost:33000';
const KRATOS_PUBLIC_URL = process.env.KRATOS_PUBLIC_URL ?? 'https://localhost:33012';
const KRATOS_ADMIN_URL = process.env.KRATOS_ADMIN_URL ?? 'http://127.0.0.1:33013';
const HYDRA_PUBLIC_URL = process.env.HYDRA_PUBLIC_URL ?? 'https://localhost:33010';
const API_URL = process.env.API_URL ?? 'https://localhost:33001';

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
};

/** Minimal RFC 6265-ish jar: host-scoped (not port-scoped, same as a real browser), path ignored —
 * every cookie this flow sets is readable from every origin involved anyway. */
class CookieJar {
  #cookies = new Map();
  absorb(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      this.#cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name) {
    return this.#cookies.get(name);
  }
}

const jar = new CookieJar();

async function fetchWithJar(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...init.headers, Cookie: jar.header() },
  });
  jar.absorb(res);
  return res;
}

/** Follows the manual redirect chain a real browser would, carrying cookies at every hop, until a
 * non-redirect response comes back. This is the whole authorize -> Hydra -> web/oauth2/login ->
 * [Kratos session already valid] -> Hydra accept -> web/oauth2/consent -> Hydra issue -> callback
 * dance — none of it needs a click once the Kratos session cookie is already in the jar. */
async function followRedirects(url) {
  let current = url;
  for (let hop = 0; hop < 15; hop++) {
    const res = await fetchWithJar(current);
    if (res.status < 300 || res.status >= 400) return res;
    current = new URL(res.headers.get('location'), current).toString();
  }
  throw new Error(`too many redirects, stuck after ${url}`);
}

function decodeJwtPayload(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

const suffix = Date.now().toString(36);
const email = `e2e-login-${suffix}@example.com`;
const password = 'E2eTestPassw0rd!';
let kratosIdentityId;

try {
  // 1. Register via Kratos's admin API (see file header for why not the self-service UI).
  const created = await fetch(`${KRATOS_ADMIN_URL}/admin/identities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_id: 'default',
      traits: { email, name: 'E2E Login Test' },
      credentials: { password: { config: { password } } },
    }),
  });
  if (!created.ok) throw new Error(`Kratos identity create failed: ${created.status} ${await created.text()}`);
  ({ id: kratosIdentityId } = await created.json());
  console.log(`created Kratos identity ${kratosIdentityId} for ${email}`);

  // 2. Kratos self-service login: init the flow, then submit credentials.
  const flowRes = await fetchWithJar(`${KRATOS_PUBLIC_URL}/self-service/login/browser`, {
    headers: { Accept: 'application/json' },
  });
  const flow = await flowRes.json();
  const csrfToken = flow.ui.nodes.find((n) => n.attributes.name === 'csrf_token').attributes.value;

  const loginRes = await fetchWithJar(flow.ui.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ csrf_token: csrfToken, identifier: email, password, method: 'password' }),
  });
  const loginBody = await loginRes.json();
  check('Kratos login succeeds', loginRes.status, 200);
  check('Kratos login returns a session for our identity', loginBody.session?.identity?.id, kratosIdentityId);

  // 3. Kratos session cookie is in the jar — walk the whole authorize->Hydra->consent->callback
  // chain with no further input, exactly like a returning browser would.
  const final = await followRedirects(`${WEB_URL}/oauth2/authorize`);
  check('lands back on the dashboard after the full OAuth2 dance', final.status, 200);
  check('an access_token cookie was set', Boolean(jar.get('access_token')), true);
  check('a refresh_token cookie was set', Boolean(jar.get('refresh_token')), true);

  const accessToken = jar.get('access_token');
  // Nothing below can say anything useful without a token; stop here and let `catch` report it.
  if (!accessToken) throw new Error('no access_token cookie: the login did not complete');
  const claims = decodeJwtPayload(accessToken);
  // Compared with what Hydra itself advertises, not a literal: the issuer is configuration
  // (infra/ory/hydra/hydra.yml urls.self.issuer) and moved from http to https with the edge.
  const discovery = await (await fetch(`${HYDRA_PUBLIC_URL}/.well-known/openid-configuration`)).json();
  // Without this a missing `issuer` would compare undefined === undefined and pass.
  if (typeof discovery.issuer !== 'string') throw new Error(`${HYDRA_PUBLIC_URL} advertises no issuer`);
  check('token issuer is the one this Hydra advertises', claims.iss, discovery.issuer);
  check('token carries no email/role claims (see docs/security.md JWT Security)', claims.email, undefined);

  // 4. GET /auth/me resolves the session end to end: Hydra JWKS verification -> Postgres lookup.
  const meRes = await fetch(`${API_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  check('GET /auth/me status', meRes.status, 200);
  check('GET /auth/me returns the identity we just logged in as', me.email, email);
  check('a fresh registration has no tenant memberships yet', me.tenants, []);

  // 5. A tenant-scoped route 403s for a user with no active tenant (TenantIsolationGuard).
  const apisRes = await fetch(`${API_URL}/api/apis`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  check('tenant-scoped route rejects a tenant-less user', apisRes.status, 403);
} catch (err) {
  // A throw is a failure, not a setup nicety: record it so the exit code is non-zero and say why
  // (`fetch failed` alone hides the cause — e.g. UNABLE_TO_VERIFY_LEAF_SIGNATURE when the edge CA
  // is not trusted).
  const cause = err?.cause?.code ?? err?.cause?.message;
  console.log(`ABORTED: ${err?.message ?? err}${cause ? ` (${cause})` : ''}`);
  results.push({ label: 'script ran to completion', ok: false });
} finally {
  // Cleanup: the Kratos identity and the Postgres User row resolveOrProvisionUser created for it.
  if (kratosIdentityId) {
    // Read the audit ids BEFORE the user goes: deleting it sets their user_id to NULL.
    const user = await prisma.user.findUnique({ where: { kratosIdentityId }, select: { id: true } }).catch(() => null);
    const rows = user
      ? await prisma.auditLog.findMany({ where: { userId: user.id }, select: { id: true, action: true } }).catch(() => [])
      : [];
    console.log(`audit rows left behind: ${rows.map((r) => `#${r.id} ${r.action}`).join(', ') || 'none'}`);
    await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${kratosIdentityId}`, { method: 'DELETE' }).catch(() => {});
    await prisma.user.deleteMany({ where: { kratosIdentityId } }).catch(() => {});
  }
  await prisma.$disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  // results.length === 0 means the try block threw before recording a single check (setup failure:
  // Kratos down, bad DATABASE_URL, etc) — without this, that prints "0/0 passed" and still exits 0.
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
}
