/**
 * API versioning (WP16) end-to-end check against the real Tyk gateway: 16 assertions covering
 * default-vs-header routing with genuinely distinct upstream responses, the classic "Version
 * information not found" 403 regression, refusing to delete a default that still has versions,
 * retiring a version (both the data-plane routing and the management API's 410 + Sunset). Creates
 * one throwaway API + two upstream stub servers and cleans up after itself (see the `finally` block).
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:versioning
 *
 * which is just:
 *   docker cp apps/api/test/e2e/api-versioning.e2e.mjs open-gateway-api:/tmp/api-versioning.e2e.mjs
 *   docker exec open-gateway-api node /tmp/api-versioning.e2e.mjs
 *
 * Deliberately NOT a Playwright spec, for the same reason as oauth2-clients.e2e.mjs next door: it
 * has to run INSIDE the api container to reach Tyk's control API (8081, not published to the host)
 * and drives the compiled service classes out of /app/apps/api/dist directly.
 *
 * Requires the stack up and the api image current (`docker compose up -d --build api`) — it reads
 * dist/, so a stale image tests stale code.
 */
import { createRequire } from 'node:module';
import http from 'node:http';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const GATEWAY = 'http://tyk-gateway:8080';

const { prisma } = require('@open-gateway/database');
const { ApiService } = require(`${ROOT}/modules/api-management/services/api.service.js`);
const { ReconcileService } = require(`${ROOT}/modules/api-management/services/reconcile.service.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { OAuthClientService } = require(`${ROOT}/modules/oauth-clients/services/oauth-client.service.js`);
const { HydraAdminService } = require(`${ROOT}/modules/oauth-clients/services/hydra-admin.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const oauthClients = new OAuthClientService(new HydraAdminService(config), tyk, config);
const reconcile = new ReconcileService(tyk);
const apiService = new ApiService(tyk, oauthClients, reconcile);

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
};
const checkTrue = (label, cond) => check(label, cond, true);

/** A tiny in-process HTTP server that always answers the same fixed body — a distinct upstream. */
function stubUpstream(body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}
// Tyk (a different container) has to reach this stub, so "localhost" is wrong here — it would mean
// tyk-gateway's own loopback. `api` is this container's own compose network alias.
const stubUrl = (server) => `http://api:${server.address().port}/`;

const suffix = Date.now().toString(36);
let tenant;
let v1Server;
let v2Server;
let base;
let child;

try {
  tenant = await prisma.tenant.findFirstOrThrow();

  v1Server = await stubUpstream({ version: 'v1-default' });
  v2Server = await stubUpstream({ version: 'v2-child' });

  // The default is created straight through Prisma + ApiService.syncNow (not `create()`, which
  // would fire-and-forget the sync and race this script) so its proxyUrl points at v1Server, an
  // upstream reachable ONLY from inside this container — same network as tyk-gateway.
  const row = await prisma.apiDefinition.create({
    data: {
      tenantId: tenant.id,
      name: `WP16 ${suffix}`,
      slug: `wp16-${suffix}`,
      proxyUrl: stubUrl(v1Server),
      listenPath: `/wp16-${suffix}/`,
      authType: 'NONE',
      status: 'ACTIVE',
      defFormat: 'OAS',
      syncStatus: 'PENDING',
    },
  });
  base = await apiService.syncNow(row.id, tenant.id);
  checkTrue('default synced to the gateway', base.syncStatus === 'SYNCED');

  const proxyPath = `/${tenant.slug}${row.listenPath}`;

  // ── no header -> default, with the distinct body only v1Server would answer ─────────────────
  const noHeader = await fetch(`${GATEWAY}${proxyPath}`);
  check('no version header -> 200', noHeader.status, 200);
  check('no version header -> the DEFAULT upstream, not just distinct config', await noHeader.json(), {
    version: 'v1-default',
  });

  // ── the classic-format regression this WP's acceptance names explicitly ─────────────────────
  // Never 403 "Version information not found" on an ordinary, not-yet-versioned OAS api.
  checkTrue(
    'never "Version information not found" before any version exists',
    noHeader.status !== 403,
  );

  // ── create a version — a genuinely different upstream, not just different config ────────────
  child = await apiService.createVersion(
    base.id,
    { versionName: 'v2', proxyUrl: stubUrl(v2Server) },
    tenant.id,
  );
  checkTrue('version synced to the gateway', child.syncStatus === 'SYNCED');
  check('the version has its own tykApiId, not the default\'s', child.tykApiId !== base.tykApiId, true);

  // createVersion awaits the CHILD's own sync, but the DEFAULT's re-sync (the one that actually
  // writes `info.versioning.versions` on the gateway) is fire-and-forget from resyncParent — give
  // it a moment to land before asserting on gateway routing.
  await new Promise((r) => setTimeout(r, 2000));

  const withHeader = await fetch(`${GATEWAY}${proxyPath}`, { headers: { 'x-api-version': 'v2' } });
  check('x-api-version: v2 -> 200', withHeader.status, 200);
  check('x-api-version: v2 -> the CHILD upstream (genuinely distinct response)', await withHeader.json(), {
    version: 'v2-child',
  });

  // Still never the classic bug, now that versioning is actually live.
  checkTrue(
    'a valid version header never 403s "Version information not found"',
    withHeader.status !== 403,
  );

  // ── deleting the default while a version exists -> 409, and the API keeps working ───────────
  let deleteDefaultStatus;
  try {
    await apiService.remove(base.id, tenant.id);
    deleteDefaultStatus = 'DELETED';
  } catch (err) {
    deleteDefaultStatus = err.constructor.name;
  }
  check('deleting the default with a version live -> ConflictException (409), not deleted', deleteDefaultStatus, 'ConflictException');

  const afterAttemptedDelete = await fetch(`${GATEWAY}${proxyPath}`);
  check('the default still answers after the refused delete — never a broken API', afterAttemptedDelete.status, 200);

  // ── retire the version — it drops off the gateway's routing, not just its own status flips ──
  // v2 was this family's only child, so retiring it takes `info.versioning.versions` to empty —
  // mapToTykOas then omits `info.versioning` entirely rather than emit an enabled-but-empty block
  // (untested Tyk territory; the S6-caveat-4 "omit rather than fake it" rule applies just as much
  // here). The gateway then ignores the stale `x-api-version` header and serves the DEFAULT's own
  // upstream — never a broken API, which is the same guarantee the 409-on-delete check above proves
  // for the "still has a live sibling" case.
  await apiService.update(child.id, { status: 'RETIRED' }, tenant.id);
  // Two fire-and-forget re-syncs follow update() (the child's own, then the default's — the one
  // that actually rewrites `info.versioning`), each with its own reload. Poll rather than guess a
  // fixed delay.
  let retiredHeader;
  let retiredBody;
  for (let attempt = 0; attempt < 10; attempt++) {
    retiredHeader = await fetch(`${GATEWAY}${proxyPath}`, { headers: { 'x-api-version': 'v2' } });
    retiredBody = await retiredHeader.json();
    if (retiredBody.version !== 'v2-child') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('a retired version is no longer served — the same header now falls through to the default', retiredBody, {
    version: 'v1-default',
  });
  check('and the API is never broken by the retirement', retiredHeader.status, 200);

  // ── the management API's own answer for a retired version: 410 + Sunset, not just data-plane ──
  let managementApiOutcome;
  try {
    await apiService.findOne(child.id, tenant.id);
    managementApiOutcome = 'RETURNED';
  } catch (err) {
    managementApiOutcome = { name: err.constructor.name, status: err.getStatus?.(), sunsetAt: err.sunsetAt };
  }
  check('GET the retired version -> RetiredVersionException (410)', managementApiOutcome.name, 'RetiredVersionException');
  check('-> status 410', managementApiOutcome.status, 410);
  checkTrue('-> carries the sunsetAt this filter turns into the Sunset header', managementApiOutcome.sunsetAt instanceof Date);
} catch (err) {
  console.error('FATAL', err);
  results.push({ label: 'script ran to completion (see FATAL above)', ok: false });
} finally {
  if (child) await apiService.remove(child.id, tenant.id).catch(() => {});
  if (base) await apiService.remove(base.id, tenant.id).catch(() => {});
  v1Server?.close();
  v2Server?.close();
  await prisma.$disconnect();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
