/**
 * OAS-02: what does Tyk OSS (the pinned image) ENFORCE per OpenAPI operation?
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:oas-capabilities
 *
 * Same shape as governance.e2e.mjs / mcp-gateway.e2e.mjs next door: it runs INSIDE the api container,
 * drives the compiled services out of dist/ (the repo's own TykClientService and mapToTykOas), and
 * talks to Tyk's control API (8081, unpublished) and data plane (8080). Requires a current api image.
 *
 * WHY IT EXISTS. `x-tyk-api-gateway.middleware.operations.<id>` accepts 23 controls (the list is the
 * gateway's own embedded schema, `__fixtures__/tyk-oas-operation-fields.v5.15.0.json`), but a control
 * the gateway ACCEPTS is not one it ENFORCES — `mcpTools.rateLimit` in this repo validated, round-tripped
 * and was never enforced. So each control below is tested against a request that must change behaviour
 * and a control request that must not. The expectations ARE the capability table
 * (`endpoint-capabilities.ts`): a Tyk upgrade that changes any of them fails here, which is the point.
 *
 * WHAT IT TOUCHES. Seven throwaway OAS APIs (`og-probe-oas02-<run>-*`) and three keys on the running
 * gateway, a local upstream on :9911 inside the api container, removed in `finally`. It bypasses
 * Postgres entirely (no ApiDefinition rows), so reconcile never sees them, and it never prints the
 * gateway secret. It leaves nothing behind unless the process is killed; a stale `og-probe-oas02-*`
 * api can be removed with `DELETE /tyk/apis/oas/<id>`.
 */
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');
const D = '/app/apps/api/dist';
const { TykClientService } = require(`${D}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${D}/common/circuit-breaker/circuit-breaker.service.js`);
const { mapToTykOas } = require(`${D}/modules/api-management/services/tyk-mappers.js`);
const { prisma } = require('@open-gateway/database');

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const redact = (s) => (SECRET ? String(s).split(SECRET).join('[REDACTED]') : String(s));
const GW = process.env.TYK_DATA_URL ?? 'http://tyk-gateway:8080';
const UP_PORT = Number(process.env.PROBE_UPSTREAM_PORT ?? 9911);
const UP = `http://api:${String(UP_PORT)}`;
const RUN = Date.now().toString(36);
const id = (k) => `og-probe-oas02-${RUN}-${k}`;
const IDS = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => [k, id(k)]));

const tyk = new TykClientService({ get: (k, d) => process.env[k] ?? d }, new CircuitBreakerService());

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

// ---- local upstream: records every hit, sleeps on /timeout ----
const hits = {};
const upstream = http.createServer((rq, rs) => {
  rq.resume();
  rq.on('end', () => {
    const path = rq.url.split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const reply = () => { rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify({ upstream: true, path })); };
    if (path === '/timeout') setTimeout(reply, 3000); else reply();
  });
});
const hit = (path) => hits[path] ?? 0;

const call = async (base, path, { method = 'GET', headers = {}, body } = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${GW}/${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(8000) });
    await r.text();
    return { status: r.status, ms: Date.now() - t0 };
  } catch {
    return { status: 'ERR', ms: Date.now() - t0 };
  }
};

let ORG;
const keyHashes = [];

/** Start from the repo's own mapper, then attach real paths/operations (what OAS-03 will do). */
function build(apiId, { authType = 'NONE', paths, operations, global }) {
  const apiDef = { id: apiId, name: apiId, tykApiId: apiId, proxyUrl: UP, listenPath: '/', authType, status: 'ACTIVE', config: {}, parentApiId: null, versionName: null, retiredAt: null, protocol: 'HTTP' };
  const doc = mapToTykOas(apiDef, { tykOrgId: ORG, slug: apiId }, '');
  doc.paths = paths;
  const x = doc['x-tyk-api-gateway'];
  x.middleware = { ...(x.middleware ?? {}), operations, ...(global ? { global: { ...(x.middleware?.global ?? {}), ...global } } : {}) };
  return doc;
}
async function push(apiId, doc) {
  const bad = (await tyk.upsertOasApi(doc)).filter((n) => !n.ok);
  if (bad.length) throw new Error(`push of ${apiId} rejected: ${redact(bad[0].error ?? 'unknown').slice(0, 300)}`);
  for (let i = 0; i < 40; i += 1) {
    if ((await call(apiId, '/__probe__')).status !== 404) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const op = (operationId, extra = {}) => ({ operationId, responses: { 200: { description: 'ok' } }, ...extra });
const GET = (operationId, extra) => ({ get: op(operationId, extra) });
const pathParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const statuses = async (n, fn) => { const out = []; for (let i = 0; i < n; i += 1) out.push((await fn()).status); return out; };

async function main() {
  ORG = (await prisma.tenant.findFirst({ select: { tykOrgId: true } })).tykOrgId;
  await new Promise((r) => upstream.listen(UP_PORT, '0.0.0.0', r));

  // ============ A: keyless API, one operation per control ============
  const A = IDS.a;
  await push(A, build(A, {
    paths: {
      '/plain': GET('plain'),
      '/blocked': GET('blocked'),
      '/blockedtpl/{id}': { parameters: [pathParam], get: op('blockedtpl') },
      '/items/{id}': { parameters: [pathParam], get: op('items') },
      '/limited': GET('limited'),
      '/cached': GET('cached'),
      '/validated': { post: op('validated', { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } } }) },
      '/mock': GET('mock'),
      '/timeout': GET('slow'),
      '/sized': { post: op('sized', { requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } } }) },
    },
    operations: {
      plain: {}, items: {},
      blocked: { block: { enabled: true } },
      blockedtpl: { block: { enabled: true } },
      limited: { rateLimit: { enabled: true, rate: 2, per: '60s' } },
      cached: { cache: { enabled: true, timeout: 60, cacheResponseCodes: [200] } },
      validated: { validateRequest: { enabled: true, errorResponseCode: 422 } },
      mock: { mockResponse: { enabled: true, code: 201, body: '{"mock":true}', headers: [{ name: 'X-Mock', value: '1' }] } },
      slow: { enforceTimeout: { enabled: true, value: 1 } },
      sized: { requestSizeLimit: { enabled: true, value: 10 } },
    },
  }));
  console.log('--- A: per-operation controls');
  check('baseline: GET /plain proxies (status, upstream hits)', [(await call(A, '/plain')).status, hit('/plain')], [200, 1]);

  const b0 = hit('/blocked');
  check('block: GET /blocked -> 403 and the upstream is never reached', [(await call(A, '/blocked')).status, hit('/blocked') - b0], [403, 0]);
  const bt0 = hit('/blockedtpl/9');
  check('block: a templated path (/blockedtpl/{id}) is matched and blocked', [(await call(A, '/blockedtpl/9')).status, hit('/blockedtpl/9') - bt0], [403, 0]);
  check('block: a sibling operation still proxies', (await call(A, '/plain')).status, 200);
  check('template: an undecorated /items/{id} proxies for /items/123', (await call(A, '/items/123')).status, 200);

  check('rateLimit: 2 per 60s -> 200,200,429,429', await statuses(4, () => call(A, '/limited')), [200, 200, 429, 429]);
  check('rateLimit: the upstream saw only the 2 allowed calls', hit('/limited'), 2);
  check('rateLimit: an undecorated sibling is unaffected', await statuses(4, () => call(A, '/plain')), [200, 200, 200, 200]);

  const c0 = hit('/cached');
  await statuses(3, () => call(A, '/cached'));
  check('cache: an operation-level cache ALONE is NOT enforced (3 calls -> 3 upstream hits)', hit('/cached') - c0, 3);

  const bad = await call(A, '/validated', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":5}' });
  const good = await call(A, '/validated', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
  check('validateRequest: schema-invalid body -> 422, valid -> 200, upstream saw only the valid one', [bad.status, good.status, hit('/validated')], [422, 200, 1]);

  const m0 = hit('/mock');
  const mock = await call(A, '/mock');
  check('mockResponse: answers 201 without reaching the upstream', [mock.status, hit('/mock') - m0], [201, 0]);

  const slow = await call(A, '/timeout');
  check('enforceTimeout: upstream sleeps 3 s, limit 1 s -> 504 in under 2.5 s', [slow.status, slow.ms < 2500], [504, true]);

  const big = await call(A, '/sized', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(100) });
  const small = await call(A, '/sized', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'xxxxx' });
  check('requestSizeLimit: 100 B over a 10 B limit -> 400 (not 413), 5 B -> 200', [big.status, small.status], [400, 200]);

  console.log('--- A: matching of what the spec does NOT describe');
  check('an undeclared path is proxied (no allow-list): 200', (await call(A, '/undefined-path')).status, 200);
  check('a trailing slash on a declared path still matches: 200', (await call(A, '/plain/')).status, 200);
  check('a method the spec does not declare is proxied: POST /plain -> 200', (await call(A, '/plain', { method: 'POST' })).status, 200);
  check('the listen path WITHOUT its trailing slash is not routed: 404', (await call(A, '')).status, 404);

  // cache needs the API-level cache switched on
  await push(A, build(A, {
    paths: { '/plain': GET('plain'), '/cached': GET('cached') },
    operations: { plain: {}, cached: { cache: { enabled: true, timeout: 60, cacheResponseCodes: [200] } } },
    global: { cache: { enabled: true, timeout: 60, cacheAllSafeRequests: false } },
  }));
  const c1 = hit('/cached');
  await statuses(3, () => call(A, '/cached'));
  check('cache: WITH middleware.global.cache.enabled the operation cache is enforced (3 calls -> 1 upstream hit)', hit('/cached') - c1, 1);

  // ============ B: allow-list mode ============
  console.log('--- B: allow');
  const B = IDS.b;
  await push(B, build(B, { paths: { '/allowed': GET('allowed'), '/other': GET('other') }, operations: { allowed: { allow: { enabled: true } }, other: {} } }));
  check('allow: the allowed operation proxies', (await call(B, '/allowed')).status, 200);
  check('allow: ONE `allow` turns on list mode — a declared operation without it is blocked (403)', [(await call(B, '/other')).status, hit('/other')], [403, 0]);
  check('allow: list mode also blocks a path the spec never declared (403)', [(await call(B, '/nowhere')).status, hit('/nowhere')], [403, 0]);

  // ============ C: authenticated API, ignoreAuthentication ============
  console.log('--- C: ignoreAuthentication');
  const C = IDS.c;
  await push(C, build(C, { authType: 'AUTH_TOKEN', paths: { '/public': GET('pub'), '/private': GET('priv') }, operations: { pub: { ignoreAuthentication: { enabled: true } }, priv: {} } }));
  const key = await tyk.createKey({ alias: 'oas02-probe', active: true, org_id: ORG, rate: 100, per: 1, quota_max: -1, quota_renewal_rate: 0, expires: 0, access_rights: { [C]: { api_id: C, api_name: C, versions: ['Default'] } } });
  keyHashes.push(key.keyHash);
  check('ignoreAuthentication: without a key /public -> 200, /private -> 401', [(await call(C, '/public')).status, (await call(C, '/private')).status], [200, 401]);
  check('ignoreAuthentication: with a key both -> 200', [(await call(C, '/public', { headers: { Authorization: key.key } })).status, (await call(C, '/private', { headers: { Authorization: key.key } })).status], [200, 200]);

  // ============ D: API-wide catch-all next to a real operation ============
  console.log('--- D: the synthetic catch-all (/{wildcard}) next to real operations');
  const Dd = IDS.d;
  await push(Dd, build(Dd, {
    paths: { '/{wildcard}': { parameters: [{ ...pathParam, name: 'wildcard' }], get: op('catchAllGET') }, '/orders': GET('orders'), '/multi': { get: op('multiGet'), post: op('multiPost') } },
    operations: { catchAllGET: { mockResponse: { enabled: true, code: 201, body: '{"wild":true}' } }, orders: {}, multiGet: { block: { enabled: true } }, multiPost: {} },
  }));
  check('a REAL operation wins over the catch-all: GET /orders is NOT mocked (200)', (await call(Dd, '/orders')).status, 200);
  check('the catch-all still applies where no real operation matches: 201', (await call(Dd, '/something')).status, 201);
  check('methods on one path are independent: GET /multi 403, POST /multi 200', [(await call(Dd, '/multi')).status, (await call(Dd, '/multi', { method: 'POST' })).status], [403, 200]);
  check('parked defect CONFIRMED: <listenPath>/ does not match /{wildcard} (proxied 200, mock skipped)', await fetch(`${GW}/${Dd}/`).then((r) => r.status), 200);

  // ============ E: root operation and read-back ============
  console.log('--- E: a root operation, and read-back fidelity');
  const E = IDS.e;
  const docE = build(E, { paths: { '/': GET('root'), '/x': GET('x') }, operations: { root: { block: { enabled: true } }, x: {} } });
  await push(E, docE);
  check('a declared `GET /` operation matches <listenPath>/ (the bare path): blocked 403', await fetch(`${GW}/${E}/`).then((r) => r.status), 403);
  const back = (await tyk.getOasApiFromNode(E, tyk.nodes[0]))['x-tyk-api-gateway']?.middleware?.operations;
  check('read-back: the operations subtree returned by the gateway is IDENTICAL to what was pushed', back, docE['x-tyk-api-gateway'].middleware.operations);

  // ============ F: cache isolation ============
  console.log('--- F: cache isolation');
  const F = IDS.f;
  await push(F, build(F, { paths: { '/fplain': GET('fplain'), '/fcached': GET('fcached') }, operations: { fplain: {}, fcached: { cache: { enabled: true, timeout: 60, cacheResponseCodes: [200] } } }, global: { cache: { enabled: true, timeout: 60, cacheAllSafeRequests: false } } }));
  for (let i = 0; i < 3; i += 1) { await call(F, '/fplain'); await call(F, '/fcached'); }
  check('global cache on with cacheAllSafeRequests:false caches ONLY the opted-in operation', [hit('/fcached'), hit('/fplain')], [1, 3]);

  // ============ G: scope of a per-operation rate limit ============
  console.log('--- G: rate-limit scope');
  const G = IDS.g;
  await push(G, build(G, { authType: 'AUTH_TOKEN', paths: { '/lim': GET('lim') }, operations: { lim: { rateLimit: { enabled: true, rate: 2, per: '60s' } } } }));
  const mk = async (n) => { const k = await tyk.createKey({ alias: `oas02-probe-${n}`, active: true, org_id: ORG, rate: 100, per: 1, quota_max: -1, quota_renewal_rate: 0, expires: 0, access_rights: { [G]: { api_id: G, api_name: G, versions: ['Default'] } } }); keyHashes.push(k.keyHash); return { Authorization: k.key }; };
  const k1 = await mk(1); const k2 = await mk(2);
  const s1 = await statuses(3, () => call(G, '/lim', { headers: k1 }));
  const s2 = await statuses(2, () => call(G, '/lim', { headers: k2 }));
  check('a per-operation rateLimit is ONE counter shared by every key: key1 200,200,429 then key2 429,429', [s1, s2], [[200, 200, 429], [429, 429]]);
}

let code = 0;
try {
  await main();
} catch (e) {
  console.log(`ABORTED: ${redact(e?.message ?? e)}`);
  results.push(false);
} finally {
  for (const apiId of Object.values(IDS)) await tyk.deleteOasApi(apiId).catch(() => {});
  for (const h of keyHashes) await tyk.deleteKey(h).catch(() => {});
  const gone = [];
  for (const apiId of Object.values(IDS)) gone.push(await fetch(`${GW}/${apiId}/x`).then((r) => r.status).catch(() => 'ERR'));
  check('cleanup: every throwaway API is gone (404)', gone, Object.values(IDS).map(() => 404));
  upstream.close();
  await prisma.$disconnect();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  code = failed === 0 && results.length > 0 ? 0 : 1;
  process.exit(code);
}
