/**
 * OAS-04: re-uploading a changed OpenAPI document onto an existing API, against the REAL database and
 * the REAL gateway, through the real sync path.
 *
 * Run it (only once a build containing OAS-03 + OAS-04 is deployed):
 *   docker cp apps/api/test/e2e/oas-spec-update.e2e.mjs open-gateway-api:/tmp/oas-spec-update.e2e.mjs
 *   docker exec open-gateway-api node /tmp/oas-spec-update.e2e.mjs
 *
 * Same shape as oas-endpoint-governance.e2e.mjs: it runs INSIDE the api container, drives the compiled
 * services from dist/ (ApiService, EndpointGovernanceService, ApiImportService, SpecUpdateService) and a
 * local upstream on :9913. It creates one throwaway API (`og-probe-oas04-<run>`), removed in `finally`
 * through ApiService.remove (row AND gateway definition). It never prints the gateway secret.
 *
 * What it proves:
 *   AC-04.1 identical bytes -> unchanged, no new version row (dryRun = the service call behind POST /apis/:id/spec/preview)
 *   AC-04.2 a renamed operationId is removed + added
 *   AC-04.3 governance of surviving keys is untouched; the removed key's governance becomes an orphan
 *   AC-04.4 removing a governed endpoint is refused without acknowledgeRemoved
 *   stale expectedVersion -> 409; two concurrent applies -> exactly one wins; another tenant -> 404
 *   on the gateway: the surviving block still answers 403, the removed endpoint's block is gone after the sync
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
const { ApiImportService } = require(`${D}/modules/api-import/services/api-import.service.js`);
const { ApiSpecService } = require(`${D}/modules/api-import/services/api-spec.service.js`);
const { SpectralLintService } = require(`${D}/modules/api-import/services/spectral-lint.service.js`);
const { SpecUpdateService } = require(`${D}/modules/api-import/services/spec-update.service.js`);
const { buildEndpointIndex } = require(`${D}/modules/api-import/services/oas-endpoints.js`);

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const redact = (s) => (SECRET ? String(s).split(SECRET).join('[REDACTED]') : String(s));
const GW = process.env.TYK_DATA_URL ?? 'http://tyk-gateway:8080';
const UP_PORT = Number(process.env.PROBE_UPSTREAM_PORT ?? 9913);
const UP = `http://api:${String(UP_PORT)}`;
const RUN = Date.now().toString(36);
const SLUG = `og-probe-oas04-${RUN}`;

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const apiService = new ApiService(tyk, new OAuthClientService(new HydraAdminService(config), tyk, config), new ReconcileService(tyk));
const governance = new EndpointGovernanceService(apiService);
const specs = new ApiSpecService();
const updater = new SpecUpdateService(new ApiImportService(new SpectralLintService(), apiService, specs), apiService);

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};
const outcome = (p) =>
  p.then(
    (r) => (r.applied ? 'applied' : r.unchanged ? 'unchanged' : 'dry'),
    (e) => `${typeof e?.getStatus === 'function' ? e.getStatus() : 'threw'} ${e?.getResponse?.().error ?? redact(e?.message ?? e)}`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const upstream = http.createServer((rq, rs) => {
  rq.resume();
  rq.on('end', () => {
    rs.setHeader('content-type', 'application/json');
    rs.end(JSON.stringify({ upstream: true }));
  });
});
const status = (base, path) =>
  fetch(`${GW}/${base}${path}`, { signal: AbortSignal.timeout(8000) })
    .then(async (r) => { await r.text(); return r.status; })
    .catch(() => 'ERR');

// ---- the documents ----
const ok200 = { 200: { description: 'ok' } };
const doc = (paths) => ({
  openapi: '3.0.3',
  info: { title: SLUG, version: '1.0.0' },
  // Linted like an import (servers are required), but a re-upload never changes the API's upstream.
  servers: [{ url: 'https://backend.example.com' }],
  paths,
});
const q = (type) => [{ name: 'q', in: 'query', schema: { type } }];
const V1 = doc({
  '/keep': { get: { operationId: 'keep', responses: ok200 } },
  '/gone': { get: { operationId: 'gone', responses: ok200 } },
  '/changed': { get: { operationId: 'changed', parameters: q('string'), responses: ok200 } },
});
const V2 = doc({
  '/keep': { get: { operationId: 'keep', responses: ok200 } },
  '/changed': { get: { operationId: 'changed', parameters: q('integer'), responses: ok200 } },
  '/added': { get: { operationId: 'added', responses: ok200 } },
});
const V3_RENAMED = doc({ ...V2.paths, '/keep': { get: { operationId: 'keepRenamed', responses: ok200 } } });
const text = (d) => JSON.stringify(d, null, 2);

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
let apiId = null;

async function main() {
  TENANT = await prisma.tenant.findFirst({ select: { id: true, slug: true } });
  if (!TENANT) throw new Error('no tenant seeded');
  await new Promise((r) => upstream.listen(UP_PORT, '0.0.0.0', r));

  // Setup: an API with V1 stored as version 1 (created directly, as the governance e2e does: the import's
  // SSRF denylist refuses the in-container upstream, and the import path is not what is under test).
  const v1 = text(V1);
  const { endpoints } = buildEndpointIndex(V1);
  const api = await apiService.create(
    { name: SLUG, slug: SLUG, proxyUrl: UP, listenPath: `/${SLUG}/`, authType: 'NONE', config: {} },
    TENANT.id,
    {
      contentHash: createHash('sha256').update(v1, 'utf8').digest('hex'),
      format: 'json',
      openapiVersion: '3.0.3',
      sourceText: v1,
      endpointIndex: endpoints,
      endpointCount: endpoints.length,
    },
  );
  apiId = api.id;
  await waitForSync(apiId);
  await apiService.update(apiId, { status: 'ACTIVE' }, TENANT.id);
  check('setup synced', await waitForSync(apiId), 'SYNCED');
  const base = `${TENANT.slug}/${SLUG}`;

  const { revision } = await governance.list(TENANT.id, apiId);
  await governance.update(TENANT.id, apiId, { expectedRevision: revision, keys: ['keep', 'gone'], set: { enabled: false } });
  check('setup: block keep+gone synced', await waitForSync(apiId), 'SYNCED');
  check('gateway before: /keep blocked', await status(base, '/keep'), 403);
  check('gateway before: /gone blocked', await status(base, '/gone'), 403);
  const configBefore = (await prisma.apiDefinition.findUnique({ where: { id: apiId }, select: { config: true } })).config;
  const versions = () => prisma.apiSpec.count({ where: { apiDefId: apiId } });
  const opts = (o) => ({ dryRun: false, expectedVersion: 1, acknowledgeRemoved: false, ...o });

  // AC-04.1
  const same = await updater.update(v1, TENANT.id, apiId, opts({}));
  check('AC-04.1 identical bytes: unchanged, not applied', [same.unchanged, same.applied, same.versionNo], [true, false, 1]);
  check('AC-04.1 no new version row', await versions(), 1);

  // Dry run
  const dry = await updater.update(text(V2), TENANT.id, apiId, opts({ dryRun: true }));
  check('dry run: added', dry.diff.added.map((r) => r.key), ['added']);
  check('dry run: removed', dry.diff.removed.map((r) => r.key), ['gone']);
  check('dry run: changed (fingerprint)', dry.diff.changed.map((c) => [c.key, c.fields]), [['changed', ['fingerprint']]]);
  check('dry run: removedGoverned', dry.governanceImpact.removedGoverned, [{ key: 'gone', governance: { enabled: false } }]);
  check('dry run: wrote nothing', await versions(), 1);

  // AC-04.2
  const renamed = await updater.update(text(V3_RENAMED), TENANT.id, apiId, opts({ dryRun: true }));
  check('AC-04.2 renamed operationId: removed', renamed.diff.removed.map((r) => r.key).sort(), ['gone', 'keep']);
  check('AC-04.2 renamed operationId: added', renamed.diff.added.map((r) => r.key).sort(), ['added', 'keepRenamed']);
  check('AC-04.2 never "changed"', renamed.diff.changed.some((c) => c.key === 'keep'), false);

  // AC-04.4 + stale + tenant
  check('AC-04.4 no acknowledgeRemoved -> 409', await outcome(updater.update(text(V2), TENANT.id, apiId, opts({}))), '409 SPEC_REMOVES_GOVERNED_ENDPOINTS');
  check('stale expectedVersion -> 409', await outcome(updater.update(text(V2), TENANT.id, apiId, opts({ expectedVersion: 7 }))), '409 SPEC_VERSION_STALE');
  const other = (await prisma.tenant.findFirst({ where: { id: { not: TENANT.id } }, select: { id: true } }))?.id ?? randomUUID();
  check('another tenant -> 404', await outcome(updater.update(text(V2), other, apiId, opts({ acknowledgeRemoved: true }))), '404 Not Found');
  const BINARY = "openapi: 3.0.3\ninfo: {title: t, version: '1'}\nservers: [{url: 'https://b.example.com'}]\npaths: {}\nx-blob: !!binary aGVsbG8=\n";
  check('!!binary scalar -> 422, not 500', await outcome(updater.update(BINARY, TENANT.id, apiId, opts({ dryRun: true }))), '422 OAS_IMPORT_UNPARSEABLE');
  check('refusals wrote nothing', await versions(), 1);

  // Apply, twice concurrently on the same expectedVersion (two different documents)
  const V2b = doc({ ...V2.paths, '/added': { get: { operationId: 'added', summary: 'other', responses: ok200 } } });
  const race = await Promise.all([text(V2), text(V2b)].map((s) => outcome(updater.update(s, TENANT.id, apiId, opts({ acknowledgeRemoved: true })))));
  check('concurrent applies: one applied, one 409', race.slice().sort(), ['409 SPEC_VERSION_STALE', 'applied']);
  check('exactly one new version', await versions(), 2);
  check('sync after apply', await waitForSync(apiId), 'SYNCED');

  // AC-04.3
  const configAfter = (await prisma.apiDefinition.findUnique({ where: { id: apiId }, select: { config: true } })).config;
  check('AC-04.3 config untouched by the apply', JSON.stringify(configAfter), JSON.stringify(configBefore));
  const view = await governance.list(TENANT.id, apiId);
  check('AC-04.3 keep keeps its governance', view.endpoints.find((e) => e.key === 'keep')?.governance, { enabled: false });
  check('removed key is an orphan, not deleted', view.orphans, [{ key: 'gone', governance: { enabled: false } }]);
  check('GET endpoints shows version 2', view.versionNo, 2);

  // The gateway serves the new index
  check('gateway after: /keep still blocked', await status(base, '/keep'), 403);
  check('gateway after: /gone no longer blocked (proxied)', await status(base, '/gone'), 200);
  check('gateway after: /added proxied', await status(base, '/added'), 200);
}

main()
  .catch((err) => {
    console.error('\nFATAL:', redact(err?.stack ?? err));
    results.push(false);
  })
  .finally(async () => {
    if (apiId) {
      await waitForSync(apiId).catch(() => {});
      await apiService.remove(apiId, TENANT?.id).catch((e) => console.log(`cleanup: ${redact(e?.message ?? e)}`));
      check('cleanup: API row removed', await prisma.apiDefinition.count({ where: { id: apiId } }), 0);
    }
    upstream.close();
    await prisma.$disconnect();
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed > 0 ? 1 : 0);
  });
