/**
 * Developer-portal sanitized spec (OAS-06) end-to-end check against the real stack: the portal's own
 * HTTP surface (DeveloperAuthGuard, the global guards, the real controller and service), Postgres
 * (stored specs, tenant scope) and the gateway (the URL the document advertises is really callable).
 *
 * What it proves, each against the real thing and not a mock:
 *   1. GET /api/portal/catalog/apis/:id for an API imported from a spec serves the STORED spec,
 *      sanitized: `servers` is the one gateway URL, no `x-tyk-*` at any depth, none of the upstream's
 *      hosts, the operation governance blocks is gone, description text is untouched.
 *   2. An API WITHOUT a stored spec is served its generated document, also sanitized: the internal
 *      `proxyUrl` (`x-tyk-api-gateway.upstream.url`) does not appear.
 *   3. A hostile stored spec that got past the import gates (inserted straight into `api_specs`) is
 *      still sanitized, and a `$ref` to a loopback listener makes ZERO connections.
 *   4. Tenant scope: another tenant's API is 404, no token is 401.
 *   4b. Publication: only an ACTIVE API that belongs to a product of the tenant is served; a DRAFT, a
 *       DISABLED and an ACTIVE-but-in-no-product API answer the same 404 as a missing id.
 *   5. The advertised base + an advertised path really reaches the upstream through the gateway.
 *
 * Creates two throwaway tenants, developers, a stub upstream and a loopback listener; cleans up in `finally`.
 *
 * Run it (only when the build containing OAS-06 is deployed):
 *   pnpm --filter @open-gateway/api test:e2e:oas-portal
 *
 * which is just:
 *   docker cp apps/api/test/e2e/oas-portal.e2e.mjs open-gateway-api:/tmp/oas-portal.e2e.mjs
 *   docker exec open-gateway-api node /tmp/oas-portal.e2e.mjs
 *
 * Requires the stack up and the api image current: it reads dist/, so a stale image tests stale code.
 * Limit: the gateway call goes to the data plane directly (http://tyk-gateway:8080), not through the
 * TLS edge the browser uses, which is not reachable from inside the api container.
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
const GATEWAY = 'http://tyk-gateway:8080';

const { prisma, tykOrgIdFor } = require('@open-gateway/database');
const { ApiImportService } = require(`${ROOT}/modules/api-import/services/api-import.service.js`);
const { ApiSpecService } = require(`${ROOT}/modules/api-import/services/api-spec.service.js`);
const { SpectralLintService } = require(`${ROOT}/modules/api-import/services/spectral-lint.service.js`);
const { ApiService } = require(`${ROOT}/modules/api-management/services/api.service.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { HydraAdminService } = require(`${ROOT}/modules/oauth-clients/services/hydra-admin.service.js`);
const { OAuthClientService } = require(`${ROOT}/modules/oauth-clients/services/oauth-client.service.js`);
const { ReconcileService } = require(`${ROOT}/modules/api-management/services/reconcile.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const oauth = new OAuthClientService(new HydraAdminService(config), tyk, config);
const apiService = new ApiService(tyk, oauth, new ReconcileService(tyk));
const importer = new ApiImportService(new SpectralLintService(), apiService, new ApiSpecService());

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
};
const checkTrue = (label, cond) => check(label, Boolean(cond), true);

const suffix = Date.now().toString(36);
const HOSTILE_TEXT = '<script>alert(1)</script> [x](javascript:alert(1))';
const INTERNAL_MARKER = `og-internal-${suffix}.corp`;
// The import gate refuses the compose service names (`api` is one), so the spec names a public-looking
// server and the API's real upstream (the stub) is set on the row afterwards, as an operator could.
const SPEC_SERVER = 'https://backend.example.com/api';

/** An upstream that records what path it was asked for. */
function stubUpstream(seen) {
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}

/** A loopback listener that counts connections: an external `$ref` must never reach it. */
function connectionCounter() {
  const state = { connections: 0 };
  const server = http.createServer((_req, res) => res.end());
  server.on('connection', () => {
    state.connections += 1;
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

async function createTenant(name, slug) {
  const id = randomUUID();
  return prisma.tenant.create({ data: { id, name, slug, tykOrgId: tykOrgIdFor(id) } });
}

/** Kratos admin identity create + a Developer row, the shortcut portal.e2e.mjs uses for its second developer. */
async function createDeveloper(tenant, label) {
  const email = `oas06-${label}-${suffix}@example.com`;
  const password = `${randomUUID()}-Aa1!`;
  const res = await fetch(`${KRATOS_ADMIN}/admin/identities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_id: 'default',
      traits: { email, name: `E2E OAS06 ${label}` },
      credentials: { password: { config: { password } } },
    }),
  });
  if (!res.ok) throw new Error(`Kratos identity create failed: ${res.status} ${await res.text()}`);
  const identity = await res.json();
  await prisma.developer.create({
    data: { tenantId: tenant.id, email, name: `Dev ${label}`, kratosIdentityId: identity.id },
  });
  return { email, password, kratosId: identity.id };
}

/** API-style (non-browser) Kratos login: a bare session token, no cookies. */
async function kratosLoginApi(email, password) {
  const flow = await fetch(`${KRATOS_PUBLIC}/self-service/login/api`, { headers: { Accept: 'application/json' } }).then((r) => r.json());
  const action = new URL(flow.ui.action);
  const submit = await fetch(`${KRATOS_PUBLIC}${action.pathname}${action.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifier: email, password, method: 'password' }),
  });
  const body = await submit.json();
  if (!body.session_token) throw new Error(`Kratos API login failed: ${submit.status}`);
  return body.session_token;
}

/** `create()` syncs in the background; deleting the row while it is PENDING strands the gateway definition. */
async function waitForSync(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.apiDefinition.findUnique({ where: { id }, select: { syncStatus: true } });
    if (!row || row.syncStatus !== 'PENDING') return row?.syncStatus ?? 'GONE';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'TIMEOUT';
}

/** A specification that passes the import gates and carries everything the sanitizer must handle. */
const importedSpec = (title) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title, version: '1.0.0', description: HOSTILE_TEXT },
    servers: [{ url: SPEC_SERVER }, { url: `https://${INTERNAL_MARKER}/v1` }],
    paths: {
      '/orders': {
        servers: [{ url: `https://${INTERNAL_MARKER}/path-level` }],
        get: {
          operationId: 'listOrders',
          summary: HOSTILE_TEXT,
          servers: [{ url: `https://${INTERNAL_MARKER}/operation-level` }],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
        },
        post: { operationId: 'createOrder', responses: { '201': { description: 'Created' } } },
      },
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: {
      schemas: {
        Order: {
          type: 'object',
          'x-tyk-note': `keep-out-${INTERNAL_MARKER}`,
          properties: { id: { type: 'string' } },
          example: { id: '1', 'x-tyk-in-example': INTERNAL_MARKER },
        },
      },
    },
  });

const servers = (doc) => doc?.servers;
const hasNone = (text, needles) => needles.every((needle) => !text.includes(needle));

let tenantA;
let tenantB;
let upstream;
let counter;
let devA;
let devB;
const seenByUpstream = [];
const cleanupApis = [];

try {
  tenantA = await createTenant(`OAS06 A ${suffix}`, `oas06-a-${suffix}`);
  tenantB = await createTenant(`OAS06 B ${suffix}`, `oas06-b-${suffix}`);
  upstream = await stubUpstream(seenByUpstream);
  counter = await connectionCounter();
  const upstreamUrl = `http://api:${upstream.address().port}`;
  const upstreamHost = `api:${upstream.address().port}`;

  devA = await createDeveloper(tenantA, 'a');
  devB = await createDeveloper(tenantB, 'b');
  const authA = { Authorization: `Bearer ${await kratosLoginApi(devA.email, devA.password)}` };
  const authB = { Authorization: `Bearer ${await kratosLoginApi(devB.email, devB.password)}` };

  // ── 1. an API imported from a spec: the stored spec, sanitized ───────────────────────────────
  const imported = await importer.import(importedSpec(`OAS06 Imported ${suffix}`), tenantA.id);
  const importedApi = imported.api;
  cleanupApis.push({ id: importedApi.id, tenantId: tenantA.id });
  check('the imported API\'s first sync settled', await waitForSync(importedApi.id), 'SYNCED');

  // Point the API at the stub, and store governance as OAS-03 does: config.endpoints[key].enabled === false.
  await prisma.apiDefinition.update({
    where: { id: importedApi.id },
    data: {
      proxyUrl: upstreamUrl,
      status: 'ACTIVE', // an import creates a DRAFT
      config: { endpoints: { createOrder: { enabled: false }, listOrders: { rateLimit: { rate: 5, per: 60 } } } },
    },
  });
  // The catalog publishes APIs through products: this one holds every API the developer may read below.
  const product = await prisma.product.create({
    data: { tenantId: tenantA.id, name: `OAS06 Product ${suffix}`, slug: `oas06-product-${suffix}`, apis: { create: [{ apiDefId: importedApi.id }] } },
  });
  const resynced = await apiService.syncNow(importedApi.id, tenantA.id);
  check('the imported API synced to the gateway against the stub upstream', resynced.syncStatus, 'SYNCED');

  const docRes = await json(`${API}/portal/catalog/apis/${importedApi.id}`, { headers: authA });
  check('GET portal/catalog/apis/:id for an imported API -> 200', docRes.status, 200);
  const doc = docRes.body.oasDocument;
  const expectedServer = `/${tenantA.slug}/${importedApi.slug}`;
  check('servers is exactly one entry: the gateway URL clients call (relative, no trailing slash)', servers(doc), [{ url: expectedServer }]);
  check('gatewayListenPath is unchanged (with its trailing slash)', docRes.body.gatewayListenPath, `${expectedServer}/`);
  checkTrue('it is the STORED spec: the real paths are there', doc?.paths?.['/orders']?.get && doc?.paths?.['/orders/{id}']?.get);
  checkTrue('no x-tyk-* anywhere (any depth, any case)', !docRes.text.toLowerCase().includes('x-tyk'));
  checkTrue(
    'none of the original server hosts, the real upstream, or the internal marker appear',
    hasNone(docRes.text, [upstreamHost, 'backend.example.com', INTERNAL_MARKER, 'keep-out-']),
  );
  check('the operation governance blocks (createOrder) is gone, its sibling stays', Object.keys(doc?.paths?.['/orders'] ?? {}).sort(), ['get']);
  check('description text is the same string (plain text is the web\'s job)', doc?.info?.description, HOSTILE_TEXT);
  check('a rate-limited (not blocked) operation is still documented', doc?.paths?.['/orders']?.get?.operationId, 'listOrders');

  // ── 5. the advertised base + an advertised path really reaches the upstream ─────────────────
  seenByUpstream.length = 0;
  const advertisedPath = '/orders';
  const callRes = await fetch(`${GATEWAY}${servers(doc)?.[0]?.url ?? ''}${advertisedPath}`);
  check('calling servers[0].url + an advertised path through the gateway -> 200', callRes.status, 200);
  checkTrue('the upstream received that path', seenByUpstream.some((url) => url.endsWith('/orders')));

  // ── 2. an API with NO stored spec: the generated document, sanitized ─────────────────────────
  const plainRow = await prisma.apiDefinition.create({
    data: {
      tenantId: tenantA.id,
      name: `OAS06 Plain ${suffix}`,
      slug: `oas06-plain-${suffix}`,
      proxyUrl: `${upstreamUrl}/internal-prefix`,
      listenPath: `/oas06-plain-${suffix}/`,
      authType: 'NONE',
      status: 'ACTIVE',
      defFormat: 'OAS',
      syncStatus: 'PENDING',
    },
  });
  const plain = await apiService.syncNow(plainRow.id, tenantA.id);
  cleanupApis.push({ id: plain.id, tenantId: tenantA.id });
  await prisma.productApi.create({ data: { productId: product.id, apiDefId: plain.id } });
  const stored = await prisma.apiDefinition.findUnique({ where: { id: plain.id }, select: { oasDocument: true } });
  checkTrue(
    'precondition: the STORED generated document really carries the internal upstream in x-tyk-api-gateway (this is what leaked)',
    JSON.stringify(stored?.oasDocument ?? {}).includes(`${upstreamHost}/internal-prefix`),
  );
  const plainRes = await json(`${API}/portal/catalog/apis/${plain.id}`, { headers: authA });
  check('GET for an API without a stored spec -> 200', plainRes.status, 200);
  checkTrue('the served generated document has no x-tyk-* and no upstream host', hasNone(plainRes.text.toLowerCase(), ['x-tyk', upstreamHost.toLowerCase(), 'internal-prefix']));
  check('its servers is the gateway URL too', servers(plainRes.body.oasDocument), [{ url: `/${tenantA.slug}/oas06-plain-${suffix}` }]);

  // ── 3. a hostile stored spec that got past the gates ─────────────────────────────────────────
  const hostileRow = await prisma.apiDefinition.create({
    data: {
      tenantId: tenantA.id,
      name: `OAS06 Hostile ${suffix}`,
      slug: `oas06-hostile-${suffix}`,
      proxyUrl: upstreamUrl,
      listenPath: `/oas06-hostile-${suffix}/`,
      authType: 'NONE',
      status: 'ACTIVE',
      defFormat: 'OAS',
      syncStatus: 'PENDING',
    },
  });
  cleanupApis.push({ id: hostileRow.id, tenantId: tenantA.id });
  await prisma.productApi.create({ data: { productId: product.id, apiDefId: hostileRow.id } });
  const hostileSource =
    `{"openapi":"3.0.3","info":{"title":"h","version":"1"},"__proto__":{"polluted":"x"},` +
    `"servers":[{"url":"https://${INTERNAL_MARKER}"}],"x-tyk-api-gateway":{"upstream":{"url":"https://${INTERNAL_MARKER}"}},` +
    `"paths":{"/a":{"servers":[{"host":"${INTERNAL_MARKER}"},{}],"get":{"servers":{"host":"${INTERNAL_MARKER}"},"responses":{"200":{"description":"ok","content":{"application/json":{"schema":` +
    `{"$ref":"http://127.0.0.1:${counter.server.address().port}/leak"}}}}}}}},"components":{"schemas":{"S":{"$id":"https://${INTERNAL_MARKER}/s","constructor":{"prototype":{"polluted":"y"}}}}}}`;
  await prisma.apiSpec.create({
    data: {
      tenantId: tenantA.id,
      apiDefId: hostileRow.id,
      versionNo: 1,
      contentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      format: 'json',
      openapiVersion: '3.0.3',
      sourceText: hostileSource,
      endpointIndex: [],
      endpointCount: 0,
    },
  });
  const hostileRes = await json(`${API}/portal/catalog/apis/${hostileRow.id}`, { headers: authA });
  check('a hostile stored spec still answers 200', hostileRes.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  check('a $ref to a loopback listener made ZERO connections', counter.state.connections, 0);
  checkTrue(
    'no x-tyk-*, internal host, external $ref target, polluting key or its payload in the response',
    hasNone(hostileRes.text, ['x-tyk', INTERNAL_MARKER, '127.0.0.1', 'polluted', '__proto__', 'prototype']),
  );
  check('its servers is the gateway URL', servers(hostileRes.body.oasDocument), [{ url: `/${tenantA.slug}/oas06-hostile-${suffix}` }]);

  // ── 4b. publication: ACTIVE and in a product of the tenant, otherwise the missing-id 404 ─────
  const unpublished = async (label, status, inProduct) => {
    const row = await prisma.apiDefinition.create({
      data: {
        tenantId: tenantA.id,
        name: `OAS06 ${label} ${suffix}`,
        slug: `oas06-${label.toLowerCase()}-${suffix}`,
        proxyUrl: upstreamUrl,
        listenPath: `/oas06-${label.toLowerCase()}-${suffix}/`,
        authType: 'NONE',
        status,
        defFormat: 'OAS',
        syncStatus: 'PENDING',
      },
    });
    cleanupApis.push({ id: row.id, tenantId: tenantA.id });
    if (inProduct) await prisma.productApi.create({ data: { productId: product.id, apiDefId: row.id } });
    return row;
  };
  const draft = await unpublished('Draft', 'DRAFT', true);
  const disabled = await unpublished('Disabled', 'DISABLED', true);
  const orphan = await unpublished('Orphan', 'ACTIVE', false);
  const missingRes = await json(`${API}/portal/catalog/apis/${randomUUID()}`, { headers: authA });
  for (const [label, row] of [['DRAFT API in a product', draft], ['DISABLED API in a product', disabled], ['ACTIVE API in no product', orphan]]) {
    const res = await json(`${API}/portal/catalog/apis/${row.id}`, { headers: authA });
    check(`${label} -> 404`, res.status, 404);
    check(`${label}: the 404 body is the same as for a missing id`, res.body?.error?.message, missingRes.body?.error?.message);
  }

  // ── 4. tenant scope and authentication ───────────────────────────────────────────────────────
  const crossTenant = await json(`${API}/portal/catalog/apis/${importedApi.id}`, { headers: authB });
  check('another tenant\'s developer reading tenant A\'s API -> 404 (not 403)', crossTenant.status, 404);
  checkTrue('the 404 body carries none of the document', !crossTenant.text.includes('listOrders'));
  const unknown = await json(`${API}/portal/catalog/apis/${randomUUID()}`, { headers: authA });
  check('an unknown id -> 404, same as a cross-tenant id', unknown.status, 404);
  const anonymous = await json(`${API}/portal/catalog/apis/${importedApi.id}`);
  check('no session -> 401', anonymous.status, 401);
  const notAUuid = await json(`${API}/portal/catalog/apis/not-a-uuid`, { headers: authA });
  check('a non-UUID id -> 400', notAUuid.status, 400);
} catch (err) {
  console.error('FATAL', err);
  results.push({ label: 'script ran to completion (see FATAL above)', ok: false });
} finally {
  upstream?.close();
  counter?.server.close();
  for (const { id, tenantId } of cleanupApis) await apiService.remove(id, tenantId).catch(() => {});

  const kratosIds = [];
  for (const tenant of [tenantA, tenantB]) {
    if (!tenant) continue;
    const developers = await prisma.developer.findMany({ where: { tenantId: tenant.id }, select: { kratosIdentityId: true } });
    kratosIds.push(...developers.map((d) => d.kratosIdentityId));
    await prisma.developer.deleteMany({ where: { tenantId: tenant.id } }).catch(() => {});
  }
  for (const kratosId of new Set([devA?.kratosId, devB?.kratosId, ...kratosIds].filter(Boolean))) {
    await fetch(`${KRATOS_ADMIN}/admin/identities/${kratosId}`, { method: 'DELETE' }).catch(() => {});
  }
  // api_specs cascade from their API and from the tenant.
  if (tenantA) await prisma.tenant.delete({ where: { id: tenantA.id } }).catch(() => {});
  if (tenantB) await prisma.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
  await prisma.$disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
}
