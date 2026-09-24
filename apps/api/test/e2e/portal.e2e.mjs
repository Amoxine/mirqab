/**
 * Portal backend (WP22) end-to-end check against the real stack: Kratos (courier + self-service
 * login), Tyk (a genuinely callable key) and the portal's own HTTP surface (guards, rate limits,
 * cross-tenant/cross-account isolation) all exercised for real — not just the service classes in
 * process, unlike oauth2-clients.e2e.mjs next door. Registration/login/portal calls go over real
 * HTTP to this same container's own server (http://localhost:4000), which is what actually proves
 * DeveloperAuthGuard, ThrottlerGuard and the global JwtAuthGuard behave as the acceptance requires —
 * driving the service classes directly would skip every guard in the request pipeline.
 *
 * Creates two throwaway tenants + one throwaway upstream stub and cleans up after itself.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:portal
 *
 * which is just:
 *   docker cp apps/api/test/e2e/portal.e2e.mjs open-gateway-api:/tmp/portal.e2e.mjs
 *   docker exec open-gateway-api node /tmp/portal.e2e.mjs
 *
 * Requires the stack up and the api image current (`docker compose up -d --build api`).
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const API = 'http://localhost:4000/api';
const KRATOS_PUBLIC = process.env.ORY_KRATOS_PUBLIC_URL ?? 'http://kratos:4433';
const KRATOS_ADMIN = process.env.ORY_KRATOS_ADMIN_URL ?? 'http://kratos:4434';
const MAILPIT = 'http://mailpit:8025';
const GATEWAY = 'http://tyk-gateway:8080';

const { prisma, tykOrgIdFor } = require('@open-gateway/database');
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { PlanService } = require(`${ROOT}/modules/plans/services/plan.service.js`);
const { ProductService } = require(`${ROOT}/modules/products/services/product.service.js`);
const { ApiService } = require(`${ROOT}/modules/api-management/services/api.service.js`);
const { ReconcileService } = require(`${ROOT}/modules/api-management/services/reconcile.service.js`);
const { OAuthClientService } = require(`${ROOT}/modules/oauth-clients/services/oauth-client.service.js`);
const { HydraAdminService } = require(`${ROOT}/modules/oauth-clients/services/hydra-admin.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const plans = new PlanService(tyk);
const products = new ProductService();
const reconcile = new ReconcileService(tyk);
const oauthClients = new OAuthClientService(new HydraAdminService(config), tyk, config);
const apiService = new ApiService(tyk, oauthClients, reconcile);

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
};
const checkTrue = (label, cond) => check(label, cond, true);

function stubUpstream(body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}
const stubUrl = (server) => `http://api:${server.address().port}/`;

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function createTenant(name, slug) {
  const id = randomUUID();
  return prisma.tenant.create({ data: { id, name, slug, tykOrgId: tykOrgIdFor(id) } });
}

/** Kratos admin-API identity create, same shortcut every other e2e script in this repo uses. */
async function createKratosIdentity(email, password) {
  const res = await fetch(`${KRATOS_ADMIN}/admin/identities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_id: 'default',
      traits: { email, name: 'E2E Portal Test' },
      credentials: { password: { config: { password } } },
    }),
  });
  if (!res.ok) throw new Error(`Kratos identity create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** API-style (non-browser) Kratos login: returns a bare session_token, no cookies involved. */
async function kratosLoginApi(email, password) {
  const flowRes = await fetch(`${KRATOS_PUBLIC}/self-service/login/api`, { headers: { Accept: 'application/json' } });
  const flow = await flowRes.json();
  const action = new URL(flow.ui.action);
  const submitRes = await fetch(`${KRATOS_PUBLIC}${action.pathname}${action.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifier: email, password, method: 'password' }),
  });
  const body = await submitRes.json();
  if (!body.session_token) throw new Error(`Kratos API login failed: ${submitRes.status} ${JSON.stringify(body)}`);
  return body.session_token;
}

const suffix = Date.now().toString(36);
let tenantA;
let tenantB;
let upstream;
let apiDefA;
let productA;
let productB;
let planOpen;
let planGated;
let devA1Id;
let devA2Id;
const cleanupApiIds = [];

try {
  tenantA = await createTenant(`WP22 A ${suffix}`, `wp22-a-${suffix}`);
  tenantB = await createTenant(`WP22 B ${suffix}`, `wp22-b-${suffix}`);

  upstream = await stubUpstream({ hello: 'from the product api' });

  // ── fixtures: an AUTH_TOKEN api, a product bundling it, two plans ────────────────────────────
  const apiRow = await prisma.apiDefinition.create({
    data: {
      tenantId: tenantA.id,
      name: `WP22 API ${suffix}`,
      slug: `wp22-api-${suffix}`,
      proxyUrl: stubUrl(upstream),
      listenPath: `/wp22-${suffix}/`,
      authType: 'AUTH_TOKEN',
      status: 'ACTIVE',
      defFormat: 'OAS',
      syncStatus: 'PENDING',
    },
  });
  apiDefA = await apiService.syncNow(apiRow.id, tenantA.id);
  cleanupApiIds.push({ id: apiDefA.id, tenantId: tenantA.id });
  checkTrue('fixture API synced to the gateway', apiDefA.syncStatus === 'SYNCED');

  productA = await products.create({ name: 'Payments Suite', slug: `payments-${suffix}`, apiIds: [apiDefA.id] }, tenantA.id);
  productB = await products.create({ name: 'Other Tenant Product', slug: `other-${suffix}` }, tenantB.id);

  planOpen = await plans.create({ name: `Gold ${suffix}`, active: true }, tenantA.id);
  planGated = await prisma.plan.create({
    data: { tenantId: tenantA.id, name: `Reviewed ${suffix}`, active: true, requiresApproval: true },
  });
  // planGated needs its own Tyk policy too (plans.create does this for planOpen already).
  await tyk.upsertPolicy({ id: planGated.id, name: planGated.name, org_id: tenantA.tykOrgId, active: true, state: 'active', rate: 0, per: 0, quota_max: -1, access_rights: {}, partitions: { quota: true, rate_limit: true, acl: false, complexity: false, per_api: false } });

  // ── developer A1: register, courier, login ───────────────────────────────────────────────────
  const emailA1 = `wp22-a1-${suffix}@example.com`;
  const password = 'Passw0rd!23';
  const registerRes = await json(`${API}/portal/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ tenantSlug: tenantA.slug, email: emailA1, name: 'Dev A1', password }),
  });
  check('register -> 201', registerRes.status, 201);
  devA1Id = registerRes.body.id;

  // Kratos courier: an integration run actually receives the verification email (WP22 acceptance).
  await new Promise((r) => setTimeout(r, 1500));
  const inbox = await fetch(`${MAILPIT}/api/v1/search?query=to:${encodeURIComponent(emailA1)}`).then((r) => r.json());
  checkTrue('verification email actually arrived in the mailbox (real courier, not the placeholder)', inbox.total >= 1);

  const tokenA1 = await kratosLoginApi(emailA1, password);
  checkTrue('developer A1 has a real Kratos session token', typeof tokenA1 === 'string' && tokenA1.length > 0);

  const authA1 = { Authorization: `Bearer ${tokenA1}` };

  // ── cross-tenant catalog isolation ───────────────────────────────────────────────────────────
  const catalogA = await json(`${API}/portal/catalog/products`, { headers: authA1 });
  check('catalog lists only this tenant\'s products', catalogA.body.map((p) => p.id), [productA.id]);

  const crossTenantGet = await json(`${API}/portal/catalog/products/${productB.id}`, { headers: authA1 });
  check('direct GET of another tenant\'s product -> 404', crossTenantGet.status, 404);

  // ── no dashboard endpoint reachable with a developer session ────────────────────────────────
  const dashboardAttempt = await json(`${API}/apis`, { headers: authA1 });
  check('a Kratos session token on a dashboard route -> 401 (not a Hydra JWT at all)', dashboardAttempt.status, 401);

  // ── register an application, subscribe to the open plan, receive a key, call the gateway ────
  const appRes = await json(`${API}/portal/applications`, {
    method: 'POST',
    headers: authA1,
    body: JSON.stringify({ name: 'My App' }),
  });
  check('create application -> 201', appRes.status, 201);
  const applicationId = appRes.body.id;

  const subRes = await json(`${API}/portal/applications/${applicationId}/subscriptions`, {
    method: 'POST',
    headers: authA1,
    body: JSON.stringify({ productId: productA.id, planId: planOpen.id }),
  });
  check('subscribe to an open plan -> 201, APPROVED', [subRes.status, subRes.body.status], [201, 'APPROVED']);
  checkTrue('a key was issued in the same call', typeof subRes.body.keyValue === 'string' && subRes.body.keyValue.length > 0);
  const issuedKey = subRes.body.keyValue;
  const subscriptionId = subRes.body.id;

  const proxyPath = `/${tenantA.slug}${apiRow.listenPath}`;
  const gatewayCall = await fetch(`${GATEWAY}${proxyPath}`, { headers: { Authorization: issuedKey } });
  check('the issued key actually calls the gateway -> 200 (the whole happy path)', gatewayCall.status, 200);

  // ── duplicate subscription -> 409 ────────────────────────────────────────────────────────────
  const dupRes = await json(`${API}/portal/applications/${applicationId}/subscriptions`, {
    method: 'POST',
    headers: authA1,
    body: JSON.stringify({ productId: productA.id, planId: planOpen.id }),
  });
  check('re-subscribing to the same product -> 409', dupRes.status, 409);

  // ── an unapproved (gated) subscription issues no key at all ─────────────────────────────────
  const app2Res = await json(`${API}/portal/applications`, {
    method: 'POST',
    headers: authA1,
    body: JSON.stringify({ name: 'My Second App' }),
  });
  const application2Id = app2Res.body.id;
  const gatedRes = await json(`${API}/portal/applications/${application2Id}/subscriptions`, {
    method: 'POST',
    headers: authA1,
    body: JSON.stringify({ productId: productA.id, planId: planGated.id }),
  });
  check('subscribing to a requiresApproval plan -> 201, PENDING', [gatedRes.status, gatedRes.body.status], [201, 'PENDING']);
  checkTrue('an unapproved subscription issues NO key at all', gatedRes.body.keyValue === undefined);

  // ── cross-account: developer A2 can never read developer A1's application ───────────────────
  // Registration (POST /portal/auth/register) already exercised above, including its real courier
  // round trip — provision A2's Kratos identity + Developer row directly instead of repeating it.
  const emailA2 = `wp22-a2-${suffix}@example.com`;
  const identityA2 = await createKratosIdentity(emailA2, password);
  devA2Id = identityA2.id;
  await prisma.developer.create({
    data: { tenantId: tenantA.id, email: emailA2, name: 'Dev A2', kratosIdentityId: devA2Id },
  });
  const tokenA2 = await kratosLoginApi(emailA2, password);
  const crossAccountGet = await json(`${API}/portal/applications/${applicationId}`, {
    headers: { Authorization: `Bearer ${tokenA2}` },
  });
  check('developer A2 reading developer A1\'s application -> 403', crossAccountGet.status, 403);

  // ── revoke: the key stops working with one consistent status, not "401 or 403" ──────────────
  const revokeRes = await json(`${API}/portal/applications/${applicationId}/subscriptions/${subscriptionId}/revoke`, {
    method: 'POST',
    headers: authA1,
  });
  check('revoke -> 200, REVOKED', [revokeRes.status, revokeRes.body.status], [200, 'REVOKED']);

  await new Promise((r) => setTimeout(r, 1000));
  const revokedCall = await fetch(`${GATEWAY}${proxyPath}`, { headers: { Authorization: issuedKey } });
  check('a revoked subscription\'s key -> 403 (one consistent status, not 401 or 403)', revokedCall.status, 403);

  // ── usage endpoint ────────────────────────────────────────────────────────────────────────────
  const usageRes = await json(`${API}/portal/applications/${applicationId}/subscriptions/${subscriptionId}/usage`, {
    headers: authA1,
  });
  check('usage endpoint -> 200 with the expected shape', [usageRes.status, typeof usageRes.body.requests], [200, 'number']);

  // ── abuse control: per-IP rate limit on sign-up ──────────────────────────────────────────────
  let sawTooManyRequests = false;
  for (let i = 0; i < 8; i++) {
    const r = await json(`${API}/portal/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ tenantSlug: tenantA.slug, email: `wp22-flood-${suffix}-${i}@example.com`, name: 'Flood', password }),
    });
    if (r.status === 429) {
      sawTooManyRequests = true;
      break;
    }
  }
  checkTrue('per-IP rate limit trips on repeated sign-ups', sawTooManyRequests);

  // ── no user-existence oracle on recovery (Kratos's own default behaviour) ───────────────────
  const recoverFlow = await fetch(`${KRATOS_PUBLIC}/self-service/recovery/api`, { headers: { Accept: 'application/json' } }).then((r) => r.json());
  const recoverAction = new URL(recoverFlow.ui.action);
  const knownRes = await fetch(`${KRATOS_PUBLIC}${recoverAction.pathname}${recoverAction.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: emailA1, method: 'code' }),
  });
  const knownBody = await knownRes.json();

  const recoverFlow2 = await fetch(`${KRATOS_PUBLIC}/self-service/recovery/api`, { headers: { Accept: 'application/json' } }).then((r) => r.json());
  const recoverAction2 = new URL(recoverFlow2.ui.action);
  const unknownRes = await fetch(`${KRATOS_PUBLIC}${recoverAction2.pathname}${recoverAction2.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: `wp22-never-registered-${suffix}@example.com`, method: 'code' }),
  });
  const unknownBody = await unknownRes.json();

  check(
    'recovery answers identically for a known and an unknown email (no user-existence oracle)',
    [knownRes.status, knownBody.state],
    [unknownRes.status, unknownBody.state],
  );
} catch (err) {
  console.error('FATAL', err);
  results.push({ label: 'script ran to completion (see FATAL above)', ok: false });
} finally {
  upstream?.close();
  if (apiDefA) await apiService.remove(apiDefA.id, tenantA.id).catch(() => {});

  // devA1Id is the Developer row's OWN id (register()'s response shape), not its Kratos identity —
  // look the real Kratos ids up from Postgres before the rows disappear. devA2Id (created directly
  // above) already IS a Kratos identity id.
  const kratosIdsToDelete = devA2Id ? [devA2Id] : [];
  if (tenantA) {
    const developers = await prisma.developer.findMany({
      where: { tenantId: tenantA.id },
      select: { kratosIdentityId: true },
    });
    kratosIdsToDelete.push(...developers.map((d) => d.kratosIdentityId));
  }
  for (const kratosId of new Set(kratosIdsToDelete)) {
    await fetch(`${KRATOS_ADMIN}/admin/identities/${kratosId}`, { method: 'DELETE' }).catch(() => {});
  }

  if (planOpen) await tyk.deletePolicy(planOpen.id).catch(() => {});
  if (planGated) await tyk.deletePolicy(planGated.id).catch(() => {});
  // Developer -> Application -> Subscription all cascade from Developer, but Subscription's own
  // FK to Plan/Product is RESTRICT (by design — see schema.prisma) — deleting a tenant cascades to
  // its Plans/Products too, and Postgres does not guarantee that happens AFTER the Developer-side
  // cascade clears the Subscriptions referencing them in the same statement. Delete Developers
  // (and everything under them) explicitly first, so the tenant cascade has nothing left to hit.
  if (tenantA) await prisma.developer.deleteMany({ where: { tenantId: tenantA.id } }).catch(() => {});
  if (tenantA) await prisma.tenant.delete({ where: { id: tenantA.id } }).catch(() => {});
  if (tenantB) await prisma.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
  await prisma.$disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
}
