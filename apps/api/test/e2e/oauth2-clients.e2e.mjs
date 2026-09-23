/**
 * OAuth2-client / data-plane end-to-end check: 13 assertions covering client create, list scoping,
 * token minting, gateway accept/reject, secret rotation, revocation and cross-tenant isolation.
 * Creates two throwaway APIs and cleans up after itself (see the `finally` block).
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:oauth2
 *
 * which is just:
 *   docker cp apps/api/test/e2e/oauth2-clients.e2e.mjs open-gateway-api:/tmp/oauth2-clients.e2e.mjs
 *   docker exec open-gateway-api node /tmp/oauth2-clients.e2e.mjs
 *
 * Deliberately NOT a Playwright spec, unlike auth.e2e.spec.ts next door. It has to run INSIDE the
 * api container: Tyk's control API (8081) is not published to the host, and it drives the compiled
 * service classes out of /app/apps/api/dist directly rather than going through HTTP. The `.mjs`
 * extension also keeps it out of playwright.config.ts's `testMatch: '**' + '/*.e2e.spec.ts'`.
 *
 * Requires the stack to be up and the api image to be current (`docker compose up -d --build api`)
 * — it reads `dist/`, so a stale image tests stale code. Everything else it needs (DATABASE_URL,
 * TYK_ADMIN_URL/SECRET, TYK_ORG_ID, ORY_HYDRA_*) is already in the container's environment.
 */
import { createRequire } from 'node:module';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const HYDRA_ADMIN = process.env.ORY_HYDRA_ADMIN_URL ?? 'http://hydra:4445';
const HYDRA_PUBLIC = process.env.ORY_HYDRA_PUBLIC_URL ?? 'http://hydra:4444';
const GATEWAY = 'http://tyk-gateway:8080';
// Upstream for the throwaway APIs. It must be reachable FROM THE GATEWAY, which rules out Hydra:
// tyk-gateway sits on open-gateway-network and hydra on ory-internal, deliberately (it is why an
// OAUTH api pins Hydra's signing key instead of fetching a JWKS URL — see api.service.ts). Proxying
// to hydra:4444 here produced 500s that looked like auth failures and were really "no route".
const UPSTREAM = 'http://api:4000';
const UPSTREAM_PATH = '/api/health';

const { prisma } = require('@open-gateway/database');
const { mapToTykFormat } = require(`${ROOT}/modules/api-management/services/tyk-mappers.js`);
const { fetchAccessTokenSigningKey } = require(`${ROOT}/modules/api-management/services/hydra-signing-key.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { HydraAdminService } = require(`${ROOT}/modules/oauth-clients/services/hydra-admin.service.js`);
const { OAuthClientService } = require(`${ROOT}/modules/oauth-clients/services/oauth-client.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };

const tyk = new TykClientService(config, new CircuitBreakerService());
const clients = new OAuthClientService(new HydraAdminService(config), tyk, config);

const results = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
};

const suffix = Date.now().toString(36);
const created = [];
let client;

// WP12c made the owning tenant part of every gateway write: `mapToTykFormat` takes the tenant's
// org and slug, and the data-plane route becomes `/{tenant.slug}{listenPath}` rather than the raw
// listen path. Hoisted here because both `makeApi` and `callGateway` need it.
const tenant = await prisma.tenant.findFirstOrThrow();
const tenantScope = { tykOrgId: tenant.tykOrgId, slug: tenant.slug };

async function makeApi(name, slug, listenPath) {
  const row = await prisma.apiDefinition.create({
    data: {
      tenantId: tenant.id,
      name,
      slug,
      // Any upstream the GATEWAY can reach that answers 200; the assertions below only care that a
      // valid token gets through, not which service answers.
      proxyUrl: UPSTREAM,
      listenPath,
      authType: 'OAUTH',
      status: 'ACTIVE',
      config: { rateLimit: { rate: 0, per: 60 } },
      syncStatus: 'PENDING',
    },
  });
  created.push(row.id);
  const { apiId } = await tyk.createApi(
    mapToTykFormat(row, tenantScope, await fetchAccessTokenSigningKey(HYDRA_ADMIN)),
  );
  return prisma.apiDefinition.update({ where: { id: row.id }, data: { tykApiId: apiId } });
}

// `${GATEWAY}/{tenant.slug}{path}` — the namespaced route WP12c introduced. Prefixing here keeps
// the six assertions below written in terms of the listen path the API was created with.
const callGateway = async (path, token) =>
  (
    await fetch(`${GATEWAY}/${tenant.slug}${path}${UPSTREAM_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).status;

const tokenRequest = (clientId, clientSecret) =>
  fetch(`${HYDRA_PUBLIC}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });

async function mintToken(clientId, clientSecret) {
  const body = await (await tokenRequest(clientId, clientSecret)).json();
  if (!body.access_token) throw new Error(`token request failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

try {
  const api = await makeApi(`WP4 ${suffix}`, `wp4-${suffix}`, `/wp4-${suffix}/`);
  const other = await makeApi(`WP4 other ${suffix}`, `wp4o-${suffix}`, `/wp4o-${suffix}/`);
  console.log(`apis on gateway: ${api.tykApiId} / ${other.tykApiId}`);

  client = await clients.create({ apiDefId: api.id, name: 'e2e consumer' }, api.tenantId);
  console.log(`client ${client.clientId}, tokenUrl ${client.tokenUrl}`);

  const listed = await clients.findByApi(api.id, api.tenantId);
  check('list returns the new client', listed.some((c) => c.clientId === client.clientId), true);
  check('list is scoped to the api', (await clients.findByApi(other.id, api.tenantId)).length, 0);

  let token = await mintToken(client.clientId, client.clientSecret);
  check('scoped api accepts the token', await callGateway(`/wp4-${suffix}`, token), 200);
  check('same api, second call (no JWKS cache bug)', await callGateway(`/wp4-${suffix}`, token), 200);
  check('unscoped api rejects the same token', await callGateway(`/wp4o-${suffix}`, token), 403);
  check('gateway rejects a garbage token', await callGateway(`/wp4-${suffix}`, 'not-a-jwt'), 403);

  const { clientId: firstId, clientSecret: firstSecret } = client;
  const rotated = await clients.rotate(client.clientId, api.tenantId);
  client = rotated;
  check('rotation keeps the client id', rotated.clientId, firstId);
  check('rotation issues a different secret', rotated.clientSecret !== firstSecret, true);
  check('the old secret no longer mints tokens', (await tokenRequest(rotated.clientId, firstSecret)).status, 401);

  token = await mintToken(rotated.clientId, rotated.clientSecret);
  check('the rotated secret still reaches the api', await callGateway(`/wp4-${suffix}`, token), 200);

  await clients.revoke(rotated.clientId, api.tenantId);
  check('a live token is rejected after revocation', await callGateway(`/wp4-${suffix}`, token), 403);
  check(
    'the revoked client cannot mint a token',
    (await tokenRequest(rotated.clientId, rotated.clientSecret)).status,
    401,
  );
  client = null;

  const probe = await clients.create({ apiDefId: api.id, name: 'isolation probe' }, api.tenantId);
  client = probe;
  check(
    'another tenant cannot rotate this client',
    await clients.rotate(probe.clientId, 'some-other-tenant').then(() => 'ALLOWED', (err) => err.constructor.name),
    'NotFoundException',
  );
} finally {
  const tenant = await prisma.tenant.findFirstOrThrow();
  if (client) await clients.revoke(client.clientId, tenant.id).catch(() => {});
  for (const id of created) {
    const row = await prisma.apiDefinition.findUnique({ where: { id } });
    if (row?.tykApiId) await tyk.deleteApi(row.tykApiId).catch(() => {});
    await prisma.apiDefinition.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
