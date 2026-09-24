/**
 * WP25 acceptance, end to end against the live stack and real Postgres.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:governance
 *
 * Same shape and same reason as plans-quotas.e2e.mjs next door: it runs INSIDE the api container,
 * driving compiled services from dist/ and talking to Tyk's control API (8081, unpublished) and to
 * Postgres through the real Prisma client.
 *
 * Covers the four acceptance bullets:
 *   1. POST /governance/export is deterministic: two calls over unchanged config are deep-equal
 *      after recursively sorting object keys (byte-identical is explicitly not the contract)
 *   2. no secrets in the bundle — grepped on the actual serialised artifact
 *   3. the drift report renders ApiService.drift()'s per-node output, not a second implementation
 *   4. "adopt from gateway" requires a configured node (SSRF guard), writes the audit entry
 *      unconditionally, and labels its response as an override — and (4b) the persist and its
 *      audit write are ONE transaction: a failed audit write rolls the persist back too
 *
 * Reuses an EXISTING synced ApiDefinition rather than creating one from scratch — building a fresh
 * synced API needs the full ApiService/OAuthClientService/HydraAdminService wiring, which is not
 * this WP's concern; every other API-management e2e in this repo that only needs "an API that is
 * already on the gateway" does the same (see plans-quotas.e2e.mjs). `adoptedFromGateway` on that
 * row is reset to whatever it was before, in the finally block, since this test only borrows it.
 */
import { createRequire } from 'node:module';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const { prisma } = require('@open-gateway/database');
const { GovernanceExportService } = require(`${ROOT}/modules/governance/services/export.service.js`);
const { GovernanceDriftService } = require(`${ROOT}/modules/governance/services/drift.service.js`);
const { GovernanceAdoptService } = require(`${ROOT}/modules/governance/services/adopt.service.js`);
const { ApiService } = require(`${ROOT}/modules/api-management/services/api.service.js`);
const { ReconcileService } = require(`${ROOT}/modules/api-management/services/reconcile.service.js`);
const { PlanService } = require(`${ROOT}/modules/plans/services/plan.service.js`);
const { ProductService } = require(`${ROOT}/modules/products/services/product.service.js`);
const { McpService } = require(`${ROOT}/modules/mcp/services/mcp.service.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { AuditService } = require(`${ROOT}/modules/audit/services/audit.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const reconcile = new ReconcileService(tyk);
const audit = new AuditService();
const exportSvc = new GovernanceExportService();
// ApiService.drift() reads only tykClient/reconcile (confirmed by reading it) — oauthClients is
// used by create()/revoke() for OAuth-type APIs, neither of which this test path touches, so a
// stub is safe here without pulling in HydraAdminService just to construct a full ApiService.
const apiSvc = new ApiService(tyk, {}, reconcile);
const driftSvc = new GovernanceDriftService(apiSvc);
const adoptSvc = new GovernanceAdoptService(tyk, audit);

const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
};

/** The acceptance's own comparison method: sort object keys recursively, then compare. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}
const stableJson = (value) => JSON.stringify(sortKeys(value));

const SUFFIX = Date.now().toString(36);
const created = { planIds: [], productIds: [] };
let previousAdoptedFromGateway;
let apiDef;

async function main() {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, slug: true, tykOrgId: true } });
  if (!tenant) throw new Error('no tenant seeded');

  apiDef = await prisma.apiDefinition.findFirst({
    where: { tenantId: tenant.id, tykApiId: { not: null }, parentApiId: null },
    select: { id: true, tykApiId: true, defFormat: true, adoptedFromGateway: true },
  });
  if (!apiDef) throw new Error('no synced API in this tenant for the drift/adopt checks');
  previousAdoptedFromGateway = apiDef.adoptedFromGateway;

  // 8, not 1: with a single row, "sorted by id" is a no-op and cannot actually distinguish an
  // explicit `orderBy: { id: 'asc' }` from an absent one — worker-8's live verification used 8
  // uncorrelated-order rows to prove the ordering claim, not just re-run the same single row twice.
  const planService = new PlanService(tyk, new McpService(tyk));
  const productService = new ProductService();
  const plans = [];
  const products = [];
  for (let i = 0; i < 8; i++) {
    const p = await planService.create(
      { name: `WP25 Gold ${SUFFIX}-${String(i)}`, rate: 10, per: 1, quotaMax: 1000, quotaPeriod: 'MONTHLY' },
      tenant.id,
    );
    created.planIds.push(p.id);
    plans.push(p);

    const prod = await productService.create(
      { name: `WP25 Bundle ${SUFFIX}-${String(i)}`, slug: `wp25-bundle-${SUFFIX}-${String(i)}`, apiIds: [apiDef.id] },
      tenant.id,
    );
    created.productIds.push(prod.id);
    products.push(prod);
  }
  const [plan] = plans;
  const [product] = products;

  // ── 1 & 2. export is deterministic and secret-free ──────────────────────────────────────
  const first = await exportSvc.export(tenant.id);
  const second = await exportSvc.export(tenant.id);
  check('1. two exports are deep-equal after stable-key serialisation', stableJson(second) === stableJson(first), true);
  check('1. the plans we just created are all in the bundle', plans.every((p) => first.plans.some((b) => b.id === p.id)), true);
  check('1. the products we just created are all in the bundle', products.every((p) => first.products.some((b) => b.id === p.id)), true);
  check('1. the api we reused is in the bundle', first.apis.some((a) => a.id === apiDef.id), true);

  const ourPlanIds = first.plans.map((p) => p.id).filter((id) => plans.some((p) => p.id === id));
  const ourProductIds = first.products.map((p) => p.id).filter((id) => products.some((p) => p.id === id));
  check('1. plans are sorted by id ascending (8 rows, not a no-op with 1)', JSON.stringify(ourPlanIds), JSON.stringify([...ourPlanIds].sort()));
  check('1. products are sorted by id ascending (8 rows, not a no-op with 1)', JSON.stringify(ourProductIds), JSON.stringify([...ourProductIds].sort()));

  const bundleText = JSON.stringify(first);
  // TYK_GW_SECRET is a compose-file-only name: docker-compose sets this CONTAINER's TYK_ADMIN_SECRET
  // to `${TYK_GW_SECRET:-tyk-gateway-secret}`, so the two are the same string under two names, and
  // only the container-visible one (TYK_ADMIN_SECRET) can actually be read from inside it — a
  // process.env.TYK_GW_SECRET check here would always be undefined by construction, not by a
  // coverage gap. Asserted as its own precondition rather than silently gating the real check on it
  // (`X.length > 0 && bundleText.includes(X)` passes vacuously the moment X is empty, which is
  // exactly the bug this replaces): if TYK_ADMIN_SECRET is ever unset, THIS fails loudly instead of
  // the absence check quietly proving nothing.
  const adminSecret = process.env.TYK_ADMIN_SECRET ?? '';
  check('2. TYK_ADMIN_SECRET is actually configured (coverage precondition for the next check)', adminSecret.length > 0, true);
  check('2. TYK_ADMIN_SECRET / TYK_GW_SECRET value absent from the bundle', bundleText.includes(adminSecret), false);
  check('2. no keyHash field name anywhere in the bundle', /keyHash/i.test(bundleText), false);
  check('2. no tykKeyId field name anywhere in the bundle', /tykKeyId/i.test(bundleText), false);
  check('2. no clientSecret field name anywhere in the bundle', /clientSecret/i.test(bundleText), false);

  // ── 3. drift report reuses ApiService.drift(), not a second implementation ──────────────
  const report = await driftSvc.report(tenant.id);
  const ours = report.apis.find((a) => a.apiDefId === apiDef.id);
  check('3. our api appears in the tenant-wide drift report', Boolean(ours), true);
  check('3. perNode carries an entry for every configured node', Object.keys(ours.perNode).length, tyk.nodes.length);
  check('3. summary totalApis counts every synced api', report.summary.totalApis, report.apis.length);
  check(
    '3. summary in-sync + drifted adds back up to the total',
    report.summary.inSyncCount + report.summary.driftedCount,
    report.summary.totalApis,
  );

  // ── 4. adopt from gateway: SSRF guard, mandatory audit entry, labelled response ──────────
  let rejected = false;
  try {
    await adoptSvc.adopt(apiDef.id, 'http://attacker.internal:9999/tyk', tenant.id);
  } catch {
    rejected = true;
  }
  check('4. adopt refuses a node outside TYK_ADMIN_URLS', rejected, true);

  const node = tyk.nodes[0];
  const auditCountBefore = await prisma.auditLog.count({ where: { tenantId: tenant.id, resource: 'ApiDefinition' } });
  const adopted = await adoptSvc.adopt(apiDef.id, node, tenant.id);
  check('4. adopt reports the node it read from', adopted.node, node);
  check('4. adopt reports at least one adopted field', adopted.adoptedFields.length > 0, true);
  check('4. response labels itself as overriding config of record', /overriding/i.test(adopted.message), true);
  check('4. response labels itself as not a routine sync', /not a routine sync/i.test(adopted.message), true);

  const row = await prisma.apiDefinition.findUnique({ where: { id: apiDef.id }, select: { adoptedFromGateway: true } });
  check('4. the adopted snapshot was actually persisted', Boolean(row.adoptedFromGateway), true);

  const auditCountAfter = await prisma.auditLog.count({ where: { tenantId: tenant.id, resource: 'ApiDefinition' } });
  check('4. exactly one mandatory AuditLog row was written', auditCountAfter - auditCountBefore, 1);

  const auditRow = await prisma.auditLog.findFirst({
    where: { tenantId: tenant.id, resource: 'ApiDefinition' },
    orderBy: { id: 'desc' },
    select: { action: true, details: true },
  });
  check('4. the audit entry action is UPDATED', auditRow.action, 'UPDATED');
  check('4. the audit entry names the node', auditRow.details.node, node);
  check('4. the audit entry names the adopted fields', JSON.stringify(auditRow.details.adoptedFields), JSON.stringify(adopted.adoptedFields));

  // ── 4b. atomicity: a failed audit write must ROLL BACK the persist (worker-8's finding) ─────
  //
  // Two separately-awaited writes were not enough: a throwing audit write made the request fail but
  // left `adoptedFromGateway` persisted anyway — an override with zero trace it happened, which is
  // exactly the state P2's escape hatch exists to prevent. A mock cannot prove a real Postgres
  // rollback, so this runs a real GovernanceAdoptService against the real database with only the
  // audit service swapped for one that throws, and checks the row afterwards.
  const beforeFailed = await prisma.apiDefinition.findUnique({ where: { id: apiDef.id }, select: { adoptedFromGateway: true } });
  const auditCountBeforeFailed = await prisma.auditLog.count({ where: { tenantId: tenant.id, resource: 'ApiDefinition' } });
  const failingAdopt = new GovernanceAdoptService(tyk, {
    recordOrThrow: async () => {
      throw new Error('simulated audit failure');
    },
  });
  let failedAdoptThrew = false;
  try {
    await failingAdopt.adopt(apiDef.id, node, tenant.id);
  } catch {
    failedAdoptThrew = true;
  }
  check('4b. adopt fails when the audit write fails', failedAdoptThrew, true);

  const afterFailed = await prisma.apiDefinition.findUnique({ where: { id: apiDef.id }, select: { adoptedFromGateway: true } });
  check(
    '4b. adoptedFromGateway is UNCHANGED after the failed attempt — rolled back, not left persisted',
    stableJson(afterFailed.adoptedFromGateway) === stableJson(beforeFailed.adoptedFromGateway),
    true,
  );
  const auditCountAfterFailed = await prisma.auditLog.count({ where: { tenantId: tenant.id, resource: 'ApiDefinition' } });
  check('4b. no AuditLog row was written by the failed attempt either', auditCountAfterFailed - auditCountBeforeFailed, 0);
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err?.stack ?? err);
    results.push({ label: 'run completed', ok: false });
  })
  .finally(async () => {
    for (const id of created.productIds) {
      await prisma.product.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of created.planIds) {
      await prisma.plan.deleteMany({ where: { id } }).catch(() => {});
      await tyk.deletePolicy(id).catch(() => {});
    }
    // We only borrowed this row for the drift/adopt checks — leave it exactly as found.
    if (apiDef) {
      await prisma.apiDefinition
        .update({ where: { id: apiDef.id }, data: { adoptedFromGateway: previousAdoptedFromGateway } })
        .catch(() => {});
    }
    await prisma.$disconnect();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('FAILED:', failed.map((r) => r.label).join(', '));
    }
    process.exit(failed.length > 0 ? 1 : 0);
  });
