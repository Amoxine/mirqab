/**
 * OAS-08b: import an OpenAPI document from a URL, watch it, detect a change, propose it, apply it —
 * against the REAL database, the REAL guarded fetcher (DNS, sockets, conditional GET) and the REAL
 * gateway sync.
 *
 * Run it (only once a build containing OAS-08a + OAS-08b is deployed and the migration applied):
 *   docker cp apps/api/test/e2e/oas-spec-source.e2e.mjs open-gateway-api:/tmp/oas-spec-source.e2e.mjs
 *   docker exec open-gateway-api node /tmp/oas-spec-source.e2e.mjs
 *
 * Same shape as oas-spec-update.e2e.mjs: it runs INSIDE the api container and drives the compiled
 * classes from dist/ — the ApiImportController and SpecSourceController handlers themselves (guards and
 * pipes are not exercised: no bearer token here), the services behind them, and its OWN
 * SpecFetcherService built like oas-spec-fetch.e2e.mjs: allow-list = this container's hostname on one
 * port, a resolver wrapper mapping that hostname to the container's own address (the default c-ares
 * resolver does not read /etc/hosts), and the TEST-only `allowOwnNetworks` option (never set by
 * production DI) because that address is on the container's own network. A listener bound to that
 * address serves a document whose content and ETag the script changes.
 * It creates one API (`og-probe-oas08-<run>`, removed in `finally` through ApiService.remove, which also
 * removes its gateway definition and — by cascade — its spec source and candidates). It leaves its audit
 * rows, like every e2e here. It never prints the gateway secret, the spec URL or its token.
 *
 * What it proves (live):
 *   import from URL with watch → API + spec v1 + source seeded with the ETag; GET source is redacted
 *   check now → 304 → UNCHANGED; a second check within 30 s → 429 SPEC_CHECK_COOLDOWN (DB clock)
 *   the URL serves a changed document → CHANGED, one PENDING candidate, a SPEC_UPDATE_DETECTED audit
 *   row with no user; GET /apis flags specUpdateAvailable; GET /spec-updates lists it
 *   diff = the OAS-04 dry run against v1; apply with a stale expectedVersion → 409; with the reviewed one
 *   → v2, candidate APPLIED, API re-synced to the gateway (SYNCED); badge gone; 304 afterwards
 *   dismiss: a further change dismissed is not proposed again; NOT_A_SPEC keeps the old ETag
 *   PUT with a metadata URL → 422 SPEC_FETCH_BLOCKED_TARGET; another tenant → 404 on every route
 *   no URL, token or host in anything this process printed
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');
const D = '/app/apps/api/dist';
const { prisma } = require('@open-gateway/database');
const { ApiService } = require(`${D}/modules/api-management/services/api.service.js`);
const { TykClientService } = require(`${D}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${D}/common/circuit-breaker/circuit-breaker.service.js`);
const { HydraAdminService } = require(`${D}/modules/oauth-clients/services/hydra-admin.service.js`);
const { OAuthClientService } = require(`${D}/modules/oauth-clients/services/oauth-client.service.js`);
const { ReconcileService } = require(`${D}/modules/api-management/services/reconcile.service.js`);
const { ApiImportService } = require(`${D}/modules/api-import/services/api-import.service.js`);
const { ApiSpecService } = require(`${D}/modules/api-import/services/api-spec.service.js`);
const { SpectralLintService } = require(`${D}/modules/api-import/services/spectral-lint.service.js`);
const { SpecUpdateService } = require(`${D}/modules/api-import/services/spec-update.service.js`);
const { SpecCandidateService } = require(`${D}/modules/api-import/services/spec-candidate.service.js`);
const { SpecSourceService } = require(`${D}/modules/api-import/services/spec-source.service.js`);
const { ApiImportController } = require(`${D}/modules/api-import/controllers/api-import.controller.js`);
const { SpecSourceController, SpecUpdatesController } = require(`${D}/modules/api-import/controllers/spec-source.controller.js`);
const { AuditService } = require(`${D}/modules/audit/services/audit.service.js`);
const { SpecFetcherService, defaultSpecResolver } = require(`${D}/modules/spec-fetch/spec-fetcher.service.js`);

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const PORT = Number(process.env.PROBE_SPEC_SOURCE_PORT ?? 9931);
const HOST = os.hostname();
const TOKEN = `e2e-tok-${Date.now().toString(36)}`;
const SPEC_URL = `http://${HOST}:${String(PORT)}/openapi.json?token=${TOKEN}`;
const RUN = Date.now().toString(36);
const SLUG = `og-probe-oas08-${RUN}`;

// Everything this process prints goes through `say`, which refuses to print the URL, host or token.
const printed = [];
const scrub = (s) => {
  let out = String(s);
  for (const needle of [SECRET, TOKEN, HOST].filter(Boolean)) out = out.split(needle).join('[REDACTED]');
  return out;
};
const say = (line) => {
  printed.push(String(line));
  console.log(scrub(line));
};

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};
const outcome = (p) =>
  p.then(
    () => 'ok',
    (e) => `${typeof e?.getStatus === 'function' ? e.getStatus() : 'threw'} ${e?.getResponse?.().error ?? e?.message ?? e}`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the served document ----
const ok200 = { 200: { description: 'ok' } };
const doc = (ops) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: SLUG, version: '1.0.0' },
    servers: [{ url: 'https://backend.example.com' }],
    paths: Object.fromEntries(ops.map((id) => [`/${id}`, { get: { operationId: id, responses: ok200 } }])),
  });
let served = { body: doc(['listOrders', 'createOrder']), etag: '"v1"' };
const hits = [];
const listener = http.createServer((rq, rs) => {
  hits.push({ inm: rq.headers['if-none-match'] ?? null });
  if (rq.headers['if-none-match'] === served.etag) {
    rs.writeHead(304, { etag: served.etag });
    rs.end();
    return;
  }
  rs.writeHead(200, { 'content-type': 'application/json', etag: served.etag });
  rs.end(served.body);
});

// ---- the services, wired as the modules wire them ----
const config = { get: (key, fallback) => (key === 'SPEC_FETCH_ALLOWED_HOSTS' ? `${HOST}:${String(PORT)}` : (process.env[key] ?? fallback)) };
const tyk = new TykClientService(config, new CircuitBreakerService());
const apiService = new ApiService(tyk, new OAuthClientService(new HydraAdminService(config), tyk, config), new ReconcileService(tyk));
const importer = new ApiImportService(new SpectralLintService(), apiService, new ApiSpecService());
const specUpdate = new SpecUpdateService(importer, apiService);
const candidates = new SpecCandidateService(specUpdate, new AuditService());
// As oas-spec-fetch.e2e.mjs: the default resolver (c-ares) does not read /etc/hosts, so a thin wrapper
// maps THIS container's hostname to its own non-loopback addresses (every other name goes to the real
// resolver), and — those addresses being on the container's own networks — the fetcher is built with
// the code-level TEST option `allowOwnNetworks` (production DI never sets SPEC_FETCH_OPTIONS). The
// policy itself (metadata refused, allow-list, redirects, limits) is still the real one.
const ownAddresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a.address);
const resolve = (host, signal) =>
  host === HOST ? Promise.resolve(ownAddresses.map((address) => ({ address, family: 4 }))) : defaultSpecResolver(host, signal);
const fetcher = new SpecFetcherService(config, resolve, undefined, { allowOwnNetworks: true });
const sources = new SpecSourceService(fetcher, candidates);
const importRoutes = new ApiImportController(importer, sources);
const sourceRoutes = new SpecSourceController(sources, candidates);
const updatesRoutes = new SpecUpdatesController(candidates);

async function waitForSync(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.apiDefinition.findUnique({ where: { id }, select: { syncStatus: true } });
    if (!row || row.syncStatus !== 'PENDING') return row ? row.syncStatus : 'GONE';
    await sleep(300);
  }
  return 'TIMEOUT';
}
/** Lets the next "check now" through: the cooldown is last_checked_at + 30 s on the DB clock. */
const cooldownOver = (id) =>
  prisma.$executeRaw`UPDATE api_spec_sources SET last_checked_at = now() - interval '31 seconds' WHERE api_def_id = ${id}`;

let TENANT;
let apiId = null;
/** A REAL second tenant, created for the 404 checks and deleted in `finally` (never a random id). */
let OTHER = null;

async function main() {
  TENANT = await prisma.tenant.findFirst({ select: { id: true } });
  if (!TENANT) throw new Error('no tenant seeded');
  if (ownAddresses.length === 0) throw new Error('no non-loopback IPv4 address in this container');
  // Bound to the FIRST address only; the resolver answers only that one so the pinned connect lands on it.
  ownAddresses.splice(1);
  await new Promise((r) => listener.listen(PORT, ownAddresses[0], r));

  // Import from URL, watching it.
  const imported = (await importRoutes.importUrl({ url: SPEC_URL, slug: SLUG, watch: true, intervalMinutes: 60 }, TENANT.id)).data;
  apiId = imported.api.id;
  check('import from URL: spec v1 stored', imported.spec.versionNo, 1);
  check('import from URL: source created, redacted', [imported.source?.configured, imported.source?.url.includes(TOKEN)], [true, false]);
  check('import synced', await waitForSync(apiId), 'SYNCED');
  const row = await prisma.apiSpecSource.findUnique({ where: { apiDefId: apiId }, select: { etag: true, url: true } });
  check('source seeded with the ETag of the imported fetch', row?.etag, '"v1"');
  check('stored URL is the full one (plain, like webhook URLs)', row?.url === SPEC_URL, true);
  const got = (await sourceRoutes.getSource(apiId, TENANT.id)).data;
  check('GET spec-source: redacted, no token', [got.url.includes(TOKEN), got.url.endsWith('/…')], [false, true]);

  // 304 through the real conditional GET, then the cooldown.
  await cooldownOver(apiId);
  check('check now: 304 -> UNCHANGED', (await sourceRoutes.check(apiId, TENANT.id)).data, { result: 'UNCHANGED' });
  check('the fetcher sent If-None-Match', hits.at(-1)?.inm, '"v1"');
  check('second check within 30 s -> 429', await outcome(sourceRoutes.check(apiId, TENANT.id)), '429 SPEC_CHECK_COOLDOWN');

  // A changed document.
  served = { body: doc(['listOrders', 'createOrder', 'getOrder']), etag: '"v2"' };
  await cooldownOver(apiId);
  const changed = (await sourceRoutes.check(apiId, TENANT.id)).data;
  await cooldownOver(apiId);
  check('the same pending content again -> still CHANGED (update waiting)', (await sourceRoutes.check(apiId, TENANT.id)).data.result, 'CHANGED');
  check('changed document -> CHANGED + PENDING candidate', [changed.result, changed.candidate?.state, changed.candidate?.diff.added], ['CHANGED', 'PENDING', 1]);
  const cid = changed.candidate?.id;
  const audit = await prisma.auditLog.findFirst({ where: { tenantId: TENANT.id, action: 'SPEC_UPDATE_DETECTED' }, orderBy: { createdAt: 'desc' } });
  check('SPEC_UPDATE_DETECTED audit row, no user', [audit?.details?.candidateId === cid, audit?.userId ?? null], [true, null]);
  const list = await apiService.findAll(TENANT.id, 1, 100, undefined, undefined, SLUG);
  check('GET /apis: specUpdateAvailable', list.data.find((a) => a.id === apiId)?.specUpdateAvailable, true);
  const updates = (await updatesRoutes.list(TENANT.id)).data.items;
  check('GET /spec-updates lists it', updates.some((i) => i.apiId === apiId && i.candidateId === cid), true);

  // Diff, stale apply, apply.
  const diff = (await sourceRoutes.diff(apiId, cid, TENANT.id)).data;
  check('diff: OAS-04 dry run against v1', [diff.dryRun, diff.versionNo, diff.diff.added.map((e) => e.key)], [true, 1, ['getOrder']]);
  check('apply with a stale expectedVersion -> 409', await outcome(sourceRoutes.apply(apiId, cid, { expectedVersion: 0 }, TENANT.id, undefined)), '409 SPEC_VERSION_STALE');
  const applied = (await sourceRoutes.apply(apiId, cid, { expectedVersion: diff.versionNo }, TENANT.id, { sub: randomUUID() })).data;
  check('apply -> v2', [applied.applied, applied.versionNo], [true, 2]);
  check('candidate APPLIED, text dropped', await prisma.specCandidate.findUnique({ where: { id: cid }, select: { state: true, sourceText: true } }), { state: 'APPLIED', sourceText: null });
  check('re-synced to the gateway', await waitForSync(apiId), 'SYNCED');
  const after = await apiService.findAll(TENANT.id, 1, 100, undefined, undefined, SLUG);
  check('badge gone after apply', after.data.find((a) => a.id === apiId)?.specUpdateAvailable, false);
  await cooldownOver(apiId);
  check('304 after the apply -> UNCHANGED', (await sourceRoutes.check(apiId, TENANT.id)).data, { result: 'UNCHANGED' });

  // Dismiss, and a broken document.
  served = { body: doc(['listOrders']), etag: '"v3"' };
  await cooldownOver(apiId);
  const third = (await sourceRoutes.check(apiId, TENANT.id)).data;
  check('dismiss', (await sourceRoutes.dismiss(apiId, third.candidate?.id, TENANT.id, undefined)).data, { state: 'DISMISSED' });
  served = { body: doc(['listOrders']), etag: '"v3b"' }; // same bytes, new ETag: re-fetched, still dismissed
  await cooldownOver(apiId);
  check('dismissed content is silent', (await sourceRoutes.check(apiId, TENANT.id)).data, { result: 'UNCHANGED' });
  served = { body: 'not: [a spec', etag: '"broken"' };
  await cooldownOver(apiId);
  check('broken document -> ERROR NOT_A_SPEC', (await sourceRoutes.check(apiId, TENANT.id)).data, { result: 'ERROR', errorCode: 'NOT_A_SPEC' });
  check('NOT_A_SPEC keeps the last good ETag', (await prisma.apiSpecSource.findUnique({ where: { apiDefId: apiId }, select: { etag: true } }))?.etag, '"v3b"');

  // Refusals.
  check(
    'PUT a metadata URL -> 422 SPEC_FETCH_BLOCKED_TARGET',
    await outcome(sourceRoutes.putSource(apiId, { url: 'http://169.254.169.254/latest/meta-data', intervalMinutes: 60 }, TENANT.id)),
    '422 SPEC_FETCH_BLOCKED_TARGET',
  );
  const otherId = randomUUID();
  OTHER = (await prisma.tenant.create({ data: { id: otherId, name: `og-probe-oas08-other-${RUN}`, slug: `og-probe-oas08-other-${RUN}`, tykOrgId: `og-probe-${otherId}` }, select: { id: true } })).id;
  const other = OTHER;
  check('second tenant exists for the isolation checks', await prisma.tenant.count({ where: { id: other } }), 1);
  check('another tenant: GET source 404', await outcome(sourceRoutes.getSource(apiId, other)), '404 Not Found');
  check('another tenant: candidates 404', await outcome(sourceRoutes.listCandidates(apiId, other)), '404 Not Found');
  check('another tenant: check 404', await outcome(sourceRoutes.check(apiId, other)), '404 Not Found');
  check('another tenant: dismiss 404', await outcome(sourceRoutes.dismiss(apiId, cid, other, undefined)), '404 Not Found');
  check('another tenant: remove 404', await outcome(sourceRoutes.removeSource(apiId, other)), '404 Not Found');
  check('another tenant: spec-updates excludes it', (await updatesRoutes.list(other)).data.items.some((i) => i.apiId === apiId), false);

  check('DELETE spec-source', (await sourceRoutes.removeSource(apiId, TENANT.id)).data, { removed: true });
}

main()
  .catch((err) => {
    say(`\nFATAL: ${err?.stack ?? err}`);
    results.push(false);
  })
  .finally(async () => {
    if (apiId) {
      await waitForSync(apiId).catch(() => {});
      await apiService.remove(apiId, TENANT?.id).catch((e) => say(`cleanup: ${e?.message ?? e}`));
      check('cleanup: API row removed', await prisma.apiDefinition.count({ where: { id: apiId } }), 0);
      check('cleanup: source and candidates cascaded', await prisma.specCandidate.count({ where: { apiDefId: apiId } }), 0);
    }
    if (OTHER) {
      await prisma.tenant.delete({ where: { id: OTHER } }).catch((e) => say(`cleanup: ${e?.message ?? e}`));
      check('cleanup: second tenant removed', await prisma.tenant.count({ where: { id: OTHER } }), 0);
    }
    listener.close();
    await prisma.$disconnect();
    check('nothing printed carried the token or the host', printed.some((l) => l.includes(TOKEN) || l.includes(HOST)), false);
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed > 0 ? 1 : 0);
  });
