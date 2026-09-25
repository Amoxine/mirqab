/**
 * OAS-03: endpoint governance through the REAL write and sync path, on the live gateway.
 *
 * Run it (only against a stack whose api image contains OAS-03):
 *   docker cp apps/api/test/e2e/oas-endpoint-governance.e2e.mjs open-gateway-api:/tmp/oas-endpoint-governance.e2e.mjs
 *   docker exec open-gateway-api node /tmp/oas-endpoint-governance.e2e.mjs
 *
 * Same shape as oas-endpoint-capabilities.e2e.mjs / oas-import.e2e.mjs next door: runs INSIDE the api
 * container and drives the compiled services from dist/ — `EndpointGovernanceService` (what
 * `PATCH /apis/:id/endpoints` calls), the real `ApiService` (compare-and-set, background sync, mapper,
 * per-node read-back) and the real Prisma client — then sends traffic through Tyk's data plane.
 * Unlike the OAS-02 probe, nothing here builds a gateway document by hand: every operation on the
 * gateway came out of `mapToTykOas` via a sync.
 *
 * WHAT IT TOUCHES. Two throwaway APIs of the first seeded tenant (`og-probe-oas03-<run>-*`, with their
 * stored spec rows), one classic-format row that is never synced, one Tyk key, and a local upstream on
 * :9912 inside the api container. All removed in `finally` (API rows through `ApiService.remove`, which
 * also deletes the gateway definition). Audit rows are not written: the services are called directly,
 * not through the HTTP interceptor. The gateway secret is never printed.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');
const D = '/app/apps/api/dist';
const { prisma } = require('@open-gateway/database');
const { ApiService } = require(`${D}/modules/api-management/services/api.service.js`);
const { EndpointGovernanceService } = require(`${D}/modules/api-management/services/endpoint-governance.service.js`);
const { TykClientService } = require(`${D}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${D}/common/circuit-breaker/circuit-breaker.service.js`);
const { HydraAdminService } = require(`${D}/modules/oauth-clients/services/hydra-admin.service.js`);
const { OAuthClientService } = require(`${D}/modules/oauth-clients/services/oauth-client.service.js`);
const { ReconcileService } = require(`${D}/modules/api-management/services/reconcile.service.js`);
const { buildEndpointIndex } = require(`${D}/modules/api-import/services/oas-endpoints.js`);

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const redact = (s) => (SECRET ? String(s).split(SECRET).join('[REDACTED]') : String(s));
const GW = process.env.TYK_DATA_URL ?? 'http://tyk-gateway:8080';
const UP_PORT = Number(process.env.PROBE_UPSTREAM_PORT ?? 9912);
const UP = `http://api:${String(UP_PORT)}`;
const RUN = Date.now().toString(36);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const oauth = new OAuthClientService(new HydraAdminService(config), tyk, config);
const reconcile = new ReconcileService(tyk);
const apiService = new ApiService(tyk, oauth, reconcile);
const governance = new EndpointGovernanceService(apiService);

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};
const statusOf = (err) => (typeof err?.getStatus === 'function' ? err.getStatus() : `threw ${redact(err?.message ?? err)}`);
const bodyOf = (err) => (typeof err?.getResponse === 'function' ? err.getResponse() : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local upstream: records every hit, sleeps on /slow ----
const hits = {};
const upstream = http.createServer((rq, rs) => {
  rq.resume();
  rq.on('end', () => {
    const path = rq.url.split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const reply = () => { rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify({ upstream: true, path })); };
    if (path === '/slow') setTimeout(reply, 3000); else reply();
  });
});
const hit = (path) => hits[path] ?? 0;

let BASE_A;
let BASE_B;
const call = async (base, path, { method = 'GET', headers = {}, body } = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${GW}/${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(8000) });
    await r.text();
    return { status: r.status, ms: Date.now() - t0, headers: r.headers };
  } catch {
    return { status: 'ERR', ms: Date.now() - t0, headers: new Headers() };
  }
};
const statuses = async (n, fn) => { const out = []; for (let i = 0; i < n; i += 1) out.push((await fn()).status); return out; };

// ---- the stored specs ----
const ok200 = { 200: { description: 'ok' } };
const nameSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
const SPEC_A = {
  openapi: '3.0.3',
  info: { title: `og-probe-oas03-${RUN}-a`, version: '1' },
  paths: {
    '/plain': { get: { operationId: 'plain', responses: ok200 } },
    '/blocked': { get: { operationId: 'blocked', tags: ['lock'], responses: ok200 } },
    '/tpl/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { operationId: 'tpl', tags: ['lock'], responses: ok200 } },
    '/limited': { get: { operationId: 'limited', responses: ok200 } },
    '/limited60': { get: { operationId: 'limited60', responses: ok200 } },
    '/limited3600': { get: { operationId: 'limited3600', responses: ok200 } },
    '/slow': { get: { operationId: 'slow', responses: ok200 } },
    '/sized': { post: { operationId: 'sized', responses: ok200 } },
    '/mocked': { get: { operationId: 'mocked', responses: ok200 } },
    '/validated': { post: { operationId: 'validatedPost', responses: ok200 }, put: { operationId: 'validatedPut', responses: ok200 } },
    '/cached': { get: { operationId: 'cached', responses: ok200 } },
    '/head': { get: { operationId: 'headGet', responses: ok200 }, head: { operationId: 'headHead', responses: ok200 } },
    '/nohead': { get: { operationId: 'noheadGet', responses: ok200 } },
  },
};
const SPEC_B = {
  openapi: '3.0.3',
  info: { title: `og-probe-oas03-${RUN}-b`, version: '1' },
  components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'Authorization' } } },
  security: [{ key: [] }],
  paths: {
    '/pub': { get: { operationId: 'pub', responses: ok200 } },
    '/priv': { get: { operationId: 'priv', responses: ok200 } },
  },
};
const storedSpec = (doc) => {
  const sourceText = JSON.stringify(doc);
  const { endpoints } = buildEndpointIndex(doc);
  return {
    contentHash: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
    format: 'json',
    openapiVersion: doc.openapi,
    sourceText,
    endpointIndex: endpoints,
    endpointCount: endpoints.length,
  };
};

async function waitForSync(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.apiDefinition.findUnique({ where: { id }, select: { syncStatus: true, syncError: true } });
    if (!row || row.syncStatus !== 'PENDING') return row ? `${row.syncStatus}${row.syncError ? `: ${row.syncError}` : ''}` : 'GONE';
    await sleep(300);
  }
  return 'TIMEOUT';
}

let TENANT;
const created = [];
const keyHashes = [];
let classicId = null;

/** PATCH /apis/:id/endpoints through the service, with the CURRENT revision, then wait for the sync. */
async function govern(id, change) {
  const { revision } = await governance.list(TENANT.id, id);
  const view = await governance.update(TENANT.id, id, { expectedRevision: revision, ...change });
  return { view, sync: await waitForSync(id) };
}

async function main() {
  TENANT = await prisma.tenant.findFirst({ select: { id: true, slug: true, tykOrgId: true } });
  if (!TENANT) throw new Error('no tenant seeded');
  await new Promise((r) => upstream.listen(UP_PORT, '0.0.0.0', r));

  const mk = async (suffix, authType, doc) => {
    const slug = `og-probe-oas03-${RUN}-${suffix}`;
    const api = await apiService.create(
      { name: slug, slug, proxyUrl: UP, listenPath: `/${slug}/`, authType, config: {} },
      TENANT.id,
      storedSpec(doc),
    );
    created.push(api.id);
    // Let the create's own background sync land before the activation, so the two cannot interleave.
    await waitForSync(api.id);
    await apiService.update(api.id, { status: 'ACTIVE' }, TENANT.id);
    check(`setup: API ${suffix} synced`, await waitForSync(api.id), 'SYNCED');
    return { id: api.id, base: `${TENANT.slug}/${slug}` };
  };
  const A = await mk('a', 'NONE', SPEC_A);
  const B = await mk('b', 'AUTH_TOKEN', SPEC_B);
  BASE_A = A.base;
  BASE_B = B.base;
  const a = (path, opts) => call(BASE_A, path, opts);

  // ============ 1: every offered control, through PATCH + sync ============
  console.log('--- 1: controls');
  let r = await govern(A.id, { tag: 'lock', set: { enabled: false } });
  check('1 block by tag: synced', r.sync, 'SYNCED');
  for (const [keys, set] of [
    [['limited'], { rateLimit: { rate: 2, per: 10 } }],
    // H1: Tyk stores these canonicalised ("60s" -> "1m", "3600s" -> "1h"); the read-back must still say SYNCED.
    [['limited60'], { rateLimit: { rate: 100, per: 60 } }],
    [['limited3600'], { rateLimit: { rate: 100, per: 3600 } }],
    [['slow'], { timeoutSeconds: 1 }],
    [['sized'], { requestSizeLimitBytes: 10 }],
    [['mocked'], { mock: { code: 201, body: '{"mock":true}', headers: [{ name: 'X-Mock', value: '1' }] } }],
    [['validatedPost', 'validatedPut'], { validateRequestSchema: nameSchema }],
    [['cached'], { cache: { timeoutSeconds: 60 } }],
  ]) {
    r = await govern(A.id, { keys, set });
    check(`1 ${Object.keys(set)[0]} on ${keys.join('+')}: synced (incl. read-back of every node)`, r.sync, 'SYNCED');
  }

  const doc = (await prisma.apiDefinition.findUnique({ where: { id: A.id }, select: { oasDocument: true } })).oasDocument;
  const tykId = (await prisma.apiDefinition.findUnique({ where: { id: A.id }, select: { tykApiId: true } })).tykApiId;
  // G10: record what the gateway gives back for every managed field (subset semantics is what the sync uses).
  const back = (await tyk.getOasApiFromNode(tykId, tyk.nodes[0]))['x-tyk-api-gateway']?.middleware?.operations ?? {};
  const sent = doc['x-tyk-api-gateway'].middleware.operations;
  const exact = Object.keys(sent).filter((k) => k.startsWith('og_ep')).every((k) => JSON.stringify(back[k]) === JSON.stringify(sent[k]));
  console.log(`INFO  read-back of og_ep* operations byte-identical on node 0: ${String(exact)}`);

  check('block: /blocked 403, upstream never reached', [(await a('/blocked')).status, hit('/blocked')], [403, 0]);
  check('block: trailing slash /blocked/ 403 (G2 twin)', (await a('/blocked/')).status, 403);
  check('block: case /BLOCKED and /Blocked/ 403 (G3 ignoreCase)', [(await a('/BLOCKED')).status, (await a('/Blocked/')).status], [403, 403]);
  check('block: templated /tpl/5 and /tpl/5/ 403', [(await a('/tpl/5')).status, (await a('/tpl/5/')).status], [403, 403]);
  check('block: sibling /plain still proxies (200)', [(await a('/plain')).status, hit('/plain')], [200, 1]);
  check('open mode, KNOWN LIMIT (G4): /blocked;a=b is proxied', (await a('/blocked;a=b')).status, 200);
  check('open mode: an undeclared path is proxied (200)', (await a('/undeclared')).status, 200);

  check('rateLimit 2 per 10s: 200,200,429', await statuses(3, () => a('/limited')), [200, 200, 429]);
  await sleep(11_000);
  check('rateLimit: the 10 s window resets (200)', (await a('/limited')).status, 200);

  const slow = await a('/slow');
  check('timeout 1 s: upstream sleeps 3 s -> 504 in < 2.5 s', [slow.status, slow.ms < 2500], [504, true]);
  check('size limit 10 B: 100 B -> 400, 5 B -> 200', [(await a('/sized', { method: 'POST', body: 'x'.repeat(100) })).status, (await a('/sized', { method: 'POST', body: 'xxxxx' })).status], [400, 200]);
  const m = await a('/mocked');
  check('mock: 201 + header, upstream never reached', [m.status, m.headers.get('x-mock'), hit('/mocked')], [201, '1', 0]);
  const json = { 'content-type': 'application/json' };
  check('validateRequest POST: bad 422, good 200', [(await a('/validated', { method: 'POST', headers: json, body: '{"nope":1}' })).status, (await a('/validated', { method: 'POST', headers: json, body: '{"name":"x"}' })).status], [422, 200]);
  check('validateRequest PUT: bad 422, good 200', [(await a('/validated', { method: 'PUT', headers: json, body: '{}' })).status, (await a('/validated', { method: 'PUT', headers: json, body: '{"name":"x"}' })).status], [422, 200]);
  for (let i = 0; i < 3; i += 1) await a('/cached');
  check('cache: 3 GETs -> 1 upstream hit', hit('/cached'), 1);
  const p0 = hit('/plain');
  for (let i = 0; i < 3; i += 1) await a('/plain');
  check('cache: an ungoverned sibling is NOT cached (3 hits)', hit('/plain') - p0, 3);

  // ============ 2: API-wide mock copied onto a real op; catch-all family around it ============
  console.log('--- 2: API-wide per-operation middleware next to real operations');
  await apiService.update(A.id, { config: { mock: { code: 202, body: '{"wide":true}' } } }, TENANT.id);
  check('2 synced', await waitForSync(A.id), 'SYNCED');
  const s0 = hit('/slow');
  check('API-wide mock reaches a REAL governed op (/slow -> 202, upstream not reached)', [(await a('/slow')).status, hit('/slow') - s0], [202, 0]);
  check('the catch-all family still covers undeclared paths in open mode (/x/y/z -> 202)', (await a('/x/y/z')).status, 202);
  check('an endpoint mock still wins over the API-wide one (/mocked -> 201)', (await a('/mocked')).status, 201);
  await apiService.update(A.id, { config: { mock: null } }, TENANT.id);
  check('2 API-wide mock cleared: synced', await waitForSync(A.id), 'SYNCED');

  // ============ 3: allow-list mode ============
  console.log('--- 3: allow-list mode');
  await apiService.update(A.id, { config: { cors: { enable: true, allowedOrigins: ['https://app.example'], allowedMethods: ['GET', 'POST'], allowedHeaders: ['Content-Type'], exposedHeaders: [], allowCredentials: false, maxAge: 60 } } }, TENANT.id);
  check('3 CORS on: synced', await waitForSync(A.id), 'SYNCED');
  r = await govern(A.id, { restrictToSpec: true });
  check('3 restrictToSpec on: synced', r.sync, 'SYNCED');
  check('allow-list: undeclared path 403, upstream not reached', [(await a('/undeclared2')).status, hit('/undeclared2')], [403, 0]);
  check('allow-list: /blocked;a=b 403 (closes G4)', (await a('/blocked;a=b')).status, 403);
  check('allow-list: declared /plain 200', (await a('/plain')).status, 200);
  check('allow-list: blocked endpoint still 403', (await a('/blocked')).status, 403);
  check('allow-list: undeclared method on a declared path (DELETE /plain) 403', (await a('/plain', { method: 'DELETE' })).status, 403);
  check('allow-list: HEAD declared (/head) 200, undeclared (/nohead) 403', [(await a('/head', { method: 'HEAD' })).status, (await a('/nohead', { method: 'HEAD' })).status], [200, 403]);
  const pre = await a('/plain', { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'GET' } });
  check('allow-list: CORS preflight still answered 204 with ACAO', [pre.status, pre.headers.get('access-control-allow-origin')], [204, 'https://app.example']);
  r = await govern(A.id, { restrictToSpec: false });
  check('3 restrictToSpec off: undeclared proxied again', [r.sync, (await a('/undeclared3')).status], ['SYNCED', 200]);

  // ============ 4: auth public on an authenticated API ============
  console.log('--- 4: auth public');
  r = await govern(B.id, { keys: ['pub'], set: { auth: 'public' } });
  check('4 synced', r.sync, 'SYNCED');
  check('auth public: without a key /pub 200, /priv 401', [(await call(BASE_B, '/pub')).status, (await call(BASE_B, '/priv')).status], [200, 401]);
  const bTyk = (await prisma.apiDefinition.findUnique({ where: { id: B.id }, select: { tykApiId: true } })).tykApiId;
  const key = await tyk.createKey({ alias: `oas03-probe-${RUN}`, active: true, org_id: TENANT.tykOrgId, rate: 100, per: 1, quota_max: -1, quota_renewal_rate: 0, expires: 0, access_rights: { [bTyk]: { api_id: bTyk, api_name: bTyk, versions: ['Default'] } } });
  keyHashes.push(key.keyHash);
  check('auth public: with a key /priv 200', (await call(BASE_B, '/priv', { headers: { Authorization: key.key } })).status, 200);

  // ============ 5: read-back detects a node that does not hold what was sent ============
  console.log('--- 5: read-back');
  const node = tyk.nodes[0];
  // A client whose push is followed by a hand edit of ONE node through the control API, before the
  // service reads back: the real ApiService read-back must see it and mark the row FAILED.
  const handEdit = async () => {
    const live = await tyk.getOasApiFromNode(tykId, node);
    const ops = live['x-tyk-api-gateway'].middleware.operations;
    const blockedId = Object.keys(ops).find((k) => k.startsWith('og_ep') && ops[k].block);
    ops[blockedId] = { ...ops[blockedId], block: { enabled: false } };
    const headers = { 'x-tyk-authorization': SECRET, 'content-type': 'application/json' };
    const put = await fetch(`${node}/apis/oas/${encodeURIComponent(tykId)}`, { method: 'PUT', headers, body: JSON.stringify(live) });
    await fetch(`${node}/reload/?block=true`, { headers });
    return put.status;
  };
  const tampering = new Proxy(tyk, {
    get(target, prop) {
      if (prop === 'upsertOasApi') {
        return async (def) => { const out = await target.upsertOasApi(def); console.log(`INFO  hand edit of node 0 -> HTTP ${String(await handEdit())}`); return out; };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const tamperedService = new ApiService(tampering, oauth, reconcile);
  const tampered = await tamperedService.syncNow(A.id, TENANT.id);
  check('read-back: a hand-altered node makes the row FAILED (not SYNCED)', [tampered.syncStatus, /report it as sent/.test(tampered.syncError ?? '')], ['FAILED', true]);
  if (tyk.nodes.length === 1) check('read-back: the altered node really lets /blocked through (200)', (await a('/blocked')).status, 200);
  else console.log(`INFO  ${String(tyk.nodes.length)} nodes: which node answers is not controlled, so the data-plane effect of the edit is not asserted`);
  const repaired = await apiService.syncNow(A.id, TENANT.id);
  check('repair: a normal sync pushes again and reads back SYNCED', repaired.syncStatus, 'SYNCED');
  check('repair: /blocked 403 again', (await a('/blocked')).status, 403);

  // ============ 6: concurrency, tenant isolation, format refusal ============
  console.log('--- 6: compare-and-set, tenant isolation, classic refusal');
  const { revision } = await governance.list(TENANT.id, A.id);
  // Hold both writers until both have read, so they provably race on the same config.
  const racing = new ApiService(tyk, oauth, reconcile);
  const original = racing.compareAndSetConfig.bind(racing);
  let waiting = [];
  racing.compareAndSetConfig = async (...args) => {
    await new Promise((resolve) => { waiting.push(resolve); if (waiting.length === 2) { waiting.forEach((w) => w()); waiting = []; } });
    return original(...args);
  };
  const g2 = new EndpointGovernanceService(racing);
  const race = await Promise.allSettled([
    g2.update(TENANT.id, A.id, { expectedRevision: revision, keys: ['plain'], set: { timeoutSeconds: 30 } }),
    g2.update(TENANT.id, A.id, { expectedRevision: revision, keys: ['plain'], set: { timeoutSeconds: 40 } }),
  ]);
  const lost = race.filter((x) => x.status === 'rejected');
  check('concurrent PATCH, same revision: exactly one wins', race.filter((x) => x.status === 'fulfilled').length, 1);
  check('... the other is 409 ENDPOINT_REVISION_STALE', [statusOf(lost[0]?.reason), bodyOf(lost[0]?.reason).error], [409, 'ENDPOINT_REVISION_STALE']);
  check('... settles', await waitForSync(A.id), 'SYNCED');
  const stale = await governance.update(TENANT.id, A.id, { expectedRevision: revision, dropOrphans: true }).catch((e) => e);
  check('a stale revision afterwards: 409', statusOf(stale), 409);

  const otherTenant = (await prisma.tenant.findFirst({ where: { id: { not: TENANT.id } }, select: { id: true } }))?.id ?? randomUUID();
  const { revision: current } = await governance.list(TENANT.id, A.id);
  check('another tenant: GET 404', statusOf(await governance.list(otherTenant, A.id).catch((e) => e)), 404);
  check('another tenant: PATCH 404', statusOf(await governance.update(otherTenant, A.id, { expectedRevision: current, dropOrphans: true }).catch((e) => e)), 404);
  check('another tenant: config unchanged', (await governance.list(TENANT.id, A.id)).revision, current);

  classicId = (await prisma.apiDefinition.create({
    data: { tenantId: TENANT.id, name: `og-probe-oas03-${RUN}-classic`, slug: `og-probe-oas03-${RUN}-classic`, proxyUrl: UP, listenPath: `/og-probe-oas03-${RUN}-classic/`, authType: 'NONE', defFormat: 'CLASSIC' },
    select: { id: true },
  })).id;
  check('classic API refused: 400', statusOf(await governance.update(TENANT.id, classicId, { expectedRevision: current, dropOrphans: true }).catch((e) => e)), 400);

  // ============ 7: orphans and dropOrphans ============
  console.log('--- 7: orphans');
  const withOrphan = await prisma.apiDefinition.findUnique({ where: { id: A.id }, select: { config: true } });
  await prisma.apiDefinition.update({ where: { id: A.id }, data: { config: { ...withOrphan.config, endpoints: { ...withOrphan.config.endpoints, gone: { enabled: false } } } } });
  const view = await governance.list(TENANT.id, A.id);
  check('an orphan key is reported, not applied', view.orphans.map((o) => o.key), ['gone']);
  r = await govern(A.id, { dropOrphans: true });
  check('dropOrphans removes it', [r.view.orphans.length, r.sync], [0, 'SYNCED']);
}

let code = 0;
try {
  await main();
} catch (e) {
  console.log(`ABORTED: ${redact(e?.stack ?? e?.message ?? e)}`);
  results.push(false);
} finally {
  for (const h of keyHashes) await tyk.deleteKey(h).catch(() => {});
  // The gateway ids, read BEFORE the rows go (a row never synced still has the default `og-<id>`).
  const tykIds = [];
  for (const id of created) {
    const row = await prisma.apiDefinition.findUnique({ where: { id }, select: { tykApiId: true } }).catch(() => null);
    tykIds.push(row?.tykApiId ?? `og-${id}`);
  }
  for (const id of created) {
    await waitForSync(id).catch(() => {});
    await apiService.remove(id, TENANT?.id).catch((e) => console.log(`cleanup: ${redact(e?.message ?? e)}`));
  }
  if (classicId) await prisma.apiDefinition.delete({ where: { id: classicId } }).catch(() => {});
  const left = await prisma.apiDefinition.count({ where: { name: { startsWith: `og-probe-oas03-${RUN}` } } });
  check('cleanup: no probe row left', left, 0);
  // Ask the CONTROL API of every node: the data plane is the wrong instrument here, because a path of a
  // deleted API falls through to another API of the tenant with a broader listen path (measured: 401).
  const presentOn = async () => {
    const present = [];
    for (const apiId of tykIds) {
      for (const node of tyk.nodes) {
        // Only a not-found answer means "gone" (same test as ReconcileService); an unreadable node is reported.
        const state = await tyk.getOasApiFromNode(apiId, node).then(
          () => 'present',
          (e) => (/not found|404/i.test(String(e?.message ?? e)) ? 'gone' : `unreadable: ${redact(e?.message ?? e).slice(0, 80)}`),
        );
        if (state !== 'gone') present.push(`${apiId}@node${String(tyk.nodes.indexOf(node))}: ${state}`);
      }
    }
    return present;
  };
  let present = await presentOn();
  for (let i = 0; i < 20 && present.length > 0; i += 1) {
    await sleep(500);
    present = await presentOn();
  }
  check('cleanup: no node holds a probe API definition (control API)', present, []);
  upstream.close();
  await prisma.$disconnect();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  code = failed === 0 && results.length > 0 ? 0 : 1;
}
process.exit(code);
