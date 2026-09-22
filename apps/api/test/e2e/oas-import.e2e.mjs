/**
 * OAS import end-to-end check (WP24): the two acceptance assertions proved against the REAL
 * database, plus the size gate.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:import
 *
 * which is just:
 *   docker cp apps/api/test/e2e/oas-import.e2e.mjs open-gateway-api:/tmp/oas-import.e2e.mjs
 *   docker exec open-gateway-api node /tmp/oas-import.e2e.mjs
 *
 * Same shape as oauth2-clients.e2e.mjs next door and for the same reason: it runs INSIDE the api
 * container, driving the compiled services from dist/ and talking to Postgres through the real
 * Prisma client. The point of that is assertion 2 — "creates no ApiDefinition row" is checked by
 * counting rows in the database before and after, not by trusting the HTTP status.
 *
 * Requires a current api image (`docker compose up -d --build api`): it reads dist/, so a stale
 * image tests stale code.
 */
import { createRequire } from 'node:module';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const { prisma } = require('@open-gateway/database');
const { ApiImportService } = require(`${ROOT}/modules/api-import/services/api-import.service.js`);
const { SpectralLintService } = require(`${ROOT}/modules/api-import/services/spectral-lint.service.js`);

const results = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
};

const SUFFIX = Date.now().toString(36);
const TITLE_OK = `WP24 Import Ok ${SUFFIX}`;
const TITLE_BAD = `WP24 Import Bad ${SUFFIX}`;

const spec = (title, { version = '1.0.0', server = 'https://backend.example.com/api' } = {}) =>
  [
    'openapi: 3.0.3',
    'info:',
    `  title: ${title}`,
    ...(version === null ? [] : [`  version: '${version}'`]),
    'servers:',
    `  - url: ${server}`,
    'paths:',
    '  /orders:',
    '    get:',
    '      responses:',
    "        '200':",
    '          description: ok',
  ].join('\n');

/**
 * `create()` fires its gateway sync and returns without awaiting it (`syncInBackground`), so the
 * row is still `PENDING` when import resolves. Deleting it in that window makes the sync's own
 * `update()` fail with "No record was found" AND strands the definition it already pushed on the
 * gateway. So: wait for the sync to settle before cleaning up.
 */
async function waitForSync(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.apiDefinition.findUnique({ where: { id }, select: { syncStatus: true } });
    if (!row || row.syncStatus !== 'PENDING') return row?.syncStatus ?? 'GONE';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'TIMEOUT';
}

/** The real ApiService, wired the way ApiManagementModule wires it. */
function buildApiService() {
  const { ApiService } = require(`${ROOT}/modules/api-management/services/api.service.js`);
  const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
  const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
  const { HydraAdminService } = require(`${ROOT}/modules/oauth-clients/services/hydra-admin.service.js`);
  const { OAuthClientService } = require(`${ROOT}/modules/oauth-clients/services/oauth-client.service.js`);
  const { ReconcileService } = require(`${ROOT}/modules/api-management/services/reconcile.service.js`);

  const config = { get: (key, fallback) => process.env[key] ?? fallback };
  const tyk = new TykClientService(config, new CircuitBreakerService());
  const oauth = new OAuthClientService(new HydraAdminService(config), tyk, config);
  return new ApiService(tyk, oauth, new ReconcileService(tyk));
}

const statusOf = (err) => (typeof err?.getStatus === 'function' ? err.getStatus() : 0);
const bodyOf = (err) => (typeof err?.getResponse === 'function' ? err.getResponse() : {});

async function main() {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, slug: true } });
  if (!tenant) throw new Error('no tenant seeded — run the seed first');
  console.log(`tenant: ${tenant.slug} (${tenant.id})\n`);

  const apiService = buildApiService();
  const service = new ApiImportService(new SpectralLintService(), apiService);
  const countRows = () => prisma.apiDefinition.count({ where: { tenantId: tenant.id } });

  // ── Assertion 1: warning-only spec creates the API and returns the findings ────────────────
  const before1 = await countRows();
  const ok = await service.import(spec(TITLE_OK), tenant.id);
  const after1 = await countRows();

  check('A1 row count +1', after1 - before1, 1);
  check('A1 findings returned', ok.findings.length > 0, true);
  check('A1 all findings non-error', ok.findings.every((f) => f.severity !== 'error'), true);

  const created = await prisma.apiDefinition.findFirst({
    where: { tenantId: tenant.id, name: TITLE_OK },
    select: { id: true, name: true, slug: true, listenPath: true, proxyUrl: true, defFormat: true, authType: true },
  });
  check('A1 row exists in DB', created !== null, true);
  check('A1 db name', created?.name, TITLE_OK);
  check('A1 db listenPath', created?.listenPath, `/${created?.slug}/`);
  check('A1 db proxyUrl', created?.proxyUrl, 'https://backend.example.com/api');
  check('A1 db defFormat', created?.defFormat, 'OAS');
  check('A1 db authType default', created?.authType, 'NONE');

  // ── Assertion 2: an error-severity finding => 422, findings, and NO row ───────────────────
  const before2 = await countRows();
  const err = await service.import(spec(TITLE_BAD, { version: null }), tenant.id).catch((e) => e);
  const after2 = await countRows();

  check('A2 status 422', statusOf(err), 422);
  check('A2 error code', bodyOf(err).error, 'OAS_LINT_FAILED');
  check('A2 findings returned', Object.keys(bodyOf(err).details ?? {}).includes('oas3-schema'), true);
  check('A2 row count unchanged', after2 - before2, 0);

  const orphan = await prisma.apiDefinition.count({ where: { tenantId: tenant.id, name: TITLE_BAD } });
  check('A2 NO orphan row in DB', orphan, 0);

  // Same, for a lint error the repo ruleset adds rather than one the built-in ruleset catches.
  const before3 = await countRows();
  const relErr = await service.import(spec(`${TITLE_BAD} rel`, { server: '/v1' }), tenant.id).catch((e) => e);
  const after3 = await countRows();
  check('A2b relative server => 422', statusOf(relErr), 422);
  check('A2b og-server-url-absolute reported',
    Object.keys(bodyOf(relErr).details ?? {}).includes('og-server-url-absolute'), true);
  check('A2b row count unchanged', after3 - before3, 0);

  // ── Size gate ─────────────────────────────────────────────────────────────────────────────
  const before4 = await countRows();
  const oversize = spec(`${TITLE_BAD} big`).replace('description: ok', `description: ${'x'.repeat(5 * 1024 * 1024 + 1)}`);
  const bigErr = await service.import(oversize, tenant.id).catch((e) => e);
  const after4 = await countRows();
  check('413 on >5MB', statusOf(bigErr), 413);
  check('413 row count unchanged', after4 - before4, 0);

  // ── Cleanup: remove only what this run created, from BOTH sides ───────────────────────────
  // Through ApiService.remove(), not a raw Prisma delete: the import really did push a definition
  // to the gateway, and deleting only the row would leave that definition stranded there.
  if (created) {
    const settled = await waitForSync(created.id);
    check('sync settled before cleanup', settled !== 'TIMEOUT' && settled !== 'PENDING', true);

    await apiService.remove(created.id, tenant.id);
    const gone = await prisma.apiDefinition.count({ where: { id: created.id } });
    check('cleanup removed the imported API row', gone, 0);

    const onGateway = await fetch(`${process.env.TYK_ADMIN_URL ?? 'http://tyk-gateway:8081/tyk'}/apis/og-${created.id}`, {
      headers: { 'x-tyk-authorization': process.env.TYK_ADMIN_SECRET ?? '' },
    }).then((r) => r.status);
    check('cleanup removed the gateway definition', onGateway, 404);
  }
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err?.stack ?? err);
    results.push({ label: 'run completed', ok: false });
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('FAILED:', failed.map((r) => r.label).join(', '));
      process.exit(1);
    }
  });
