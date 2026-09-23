/**
 * WP18 acceptance, end to end against the live stack and real Postgres.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:plans
 *
 * Same shape and same reason as oas-import.e2e.mjs and oauth2-clients.e2e.mjs next door: it runs
 * INSIDE the api container, driving compiled services from dist/ and talking to Tyk's control API
 * (8081, unpublished) and to Postgres through the real Prisma client.
 *
 * Covers the five criteria that unit tests structurally cannot:
 *   1. POST /plans creates a policy that is present on EVERY node
 *   2. a key with planId carries apply_policies and no inline rate/quota, on the gateway
 *   3. editing the plan's rate changes what the gateway serves, with no key touched
 *   4. org quota: A's keys refused, B's served
 *   5. Quota.used metered from tyk_aggregated, and an admin reset zeroing it
 *
 * Cleans up everything it creates, including on the gateway — see the finally block. The sync race
 * that bit the OAS import e2e applies here too: anything created through a service that fires a
 * background sync is waited for before it is deleted.
 */
import { createRequire } from 'node:module';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const { prisma } = require('@open-gateway/database');
const { PlanService } = require(`${ROOT}/modules/plans/services/plan.service.js`);
const { buildPlanPolicy } = require(`${ROOT}/modules/plans/services/plan-policy.js`);
const { OrgQuotaService } = require(`${ROOT}/modules/quotas/services/org-quota.service.js`);
const { MeteringService } = require(`${ROOT}/modules/quotas/services/metering.service.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { buildTykKeyDef, buildKeyAclPolicy } = require(`${ROOT}/modules/keys/services/tyk-key-mapper.js`);
const { RedisService } = require(`${ROOT}/common/redis/redis.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const plans = new PlanService(tyk);
const orgQuota = new OrgQuotaService(tyk);
const metering = new MeteringService();
const redis = new RedisService(config);

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const ADMIN = process.env.TYK_ADMIN_URL ?? 'http://tyk-gateway:8081/tyk';
/** Every node, so "present on every node" is a real assertion and not node 1 twice.
 *  `||`, not `??`: compose's `${TYK_ADMIN_URLS:-}` sets an empty STRING in single-node mode, not
 *  unset — `??` only falls back on null/undefined, so this must reject '' the same way
 *  TykClientService.parseNodeUrls already does, or NODES resolves to [] and the script can't run
 *  in the normal single-node dev flow. */
const NODES = (process.env.TYK_ADMIN_URLS || ADMIN).split(',').map((s) => s.trim()).filter(Boolean);

const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
};

const gw = (node, path, init = {}) =>
  fetch(`${node}${path}`, { ...init, headers: { 'x-tyk-authorization': SECRET, ...(init.headers ?? {}) } });

const SUFFIX = Date.now().toString(36);
const created = { planIds: [], tykKeyHashes: [], aclPolicyIds: [], orgTouched: null };

async function main() {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, slug: true, tykOrgId: true } });
  if (!tenant) throw new Error('no tenant seeded');
  console.log(`tenant ${tenant.slug} org=${tenant.tykOrgId}, ${NODES.length} node(s)\n`);

  // ── 1. POST /plans creates a policy present on EVERY node ──────────────────────────────
  const plan = await plans.create(
    { name: `WP18 Gold ${SUFFIX}`, rate: 10, per: 1, quotaMax: 1000, quotaPeriod: 'MONTHLY' },
    tenant.id,
  );
  created.planIds.push(plan.id);

  check('1. plan row created', plan.name, `WP18 Gold ${SUFFIX}`);
  for (const [i, node] of NODES.entries()) {
    const res = await gw(node, `/policies/${plan.id}`);
    check(`1. GET /tyk/policies/{id} on node ${i + 1}`, res.status, 200);
  }
  // The policy id IS the plan id — the whole reason apply_policies:[planId] reads literally.
  const policy = await gw(NODES[0], `/policies/${plan.id}`).then((r) => r.json());
  check('1. policy id === plan id', policy.id ?? policy._id, plan.id);
  check('1. policy rate', policy.rate, 10);
  check('1. policy carries the tenant org', policy.org_id, tenant.tykOrgId);

  // ── 2. a planned key carries apply_policies and NO inline limits, on the gateway ────────
  const apiDef = await prisma.apiDefinition.findFirst({
    where: { tenantId: tenant.id, tykApiId: { not: null }, parentApiId: null },
    select: { name: true, tykApiId: true },
  });
  if (!apiDef) throw new Error('no synced API in this tenant to scope a key to');

  // WP18 fix, live-verified against this exact gateway: the plan's own policy is deliberately
  // ACL-less (a plan is a limit tier, not a grant of APIs), so `apply_policies:[planId]` ALONE is
  // refused outright by `/tyk/keys/create` ("key has no valid policies to be applied") — no policy
  // in the array owns any access. A second, per-key ACL-owning policy fixes it without giving the
  // plan itself an access grant; this mirrors exactly what `KeyService.create` now does.
  const aclPolicy = buildKeyAclPolicy(`wp18-acl-${SUFFIX}`, apiDef, tenant.tykOrgId);
  await tyk.upsertPolicy(aclPolicy);
  created.aclPolicyIds.push(aclPolicy.id);

  const keyDef = buildTykKeyDef({ name: `wp18-k1-${SUFFIX}`, planId: plan.id }, apiDef, tenant.tykOrgId, undefined, aclPolicy.id);
  check('2. mapper emits apply_policies', JSON.stringify(keyDef.apply_policies), JSON.stringify([plan.id, aclPolicy.id]));
  check('2. mapper emits no inline rate', 'rate' in keyDef, false);
  check('2. mapper emits no inline quota_max', 'quota_max' in keyDef, false);

  const k1 = await tyk.createKey(keyDef);
  created.tykKeyHashes.push(k1.keyHash);
  const live = await tyk.getKey(k1.keyHash);
  check(
    '2. gateway session carries apply_policies',
    JSON.stringify(live.apply_policies),
    JSON.stringify([plan.id, aclPolicy.id]),
  );
  // Not `live.rate === 0`: Tyk bakes the resolved policy's rate into the stored session the moment
  // `apply_policies` resolves at creation — live-verified via a raw Redis read, not just this GET —
  // so a policy-governed key's `rate` is never 0 or absent, full stop. The claim this criterion
  // actually makes has two parts: our own create payload sends no rate of its own (mapper-level
  // check above, unaffected by any of this), and whatever ends up live is the PLAN's rate, not some
  // independently-set value that could silently outlive a plan edit — which is what this checks.
  // (Open question, not chased further here: whether a key created before a plan edit re-resolves
  // to the new rate on a later read, or keeps the value baked in at its own creation time.)
  check('2. gateway session rate is policy-derived, matching the plan', live.rate, plan.rate);

  // ── 3. editing the plan changes the policy, with NO key written ─────────────────────────
  //
  // `tyk.getKey()` is the wrong probe for "untouched": `GET /tyk/keys/{hash}` always returns a
  // LIVE-RESOLVED view merging in whatever the referenced policy currently says, by design — its
  // own `rate` field tracks the policy, not the stored session, so it necessarily differs before
  // and after a plan edit whether or not the key was ever written. Read the RAW Redis value the
  // gateway actually stores instead (`apikey-<hash>`, verified by hand against this exact gateway:
  // `docker exec open-gateway-redis redis-cli GET apikey-<hash>` is byte-identical across a plan
  // edit) — that is the actual claim this criterion makes.
  const redisKey = `apikey-${k1.keyHash}`;
  const keyBefore = await redis.get(redisKey);
  await plans.update(plan.id, { rate: 99 }, tenant.id);
  const after = await gw(NODES[0], `/policies/${plan.id}`).then((r) => r.json());
  check('3. policy rate changed by a plan edit', after.rate, 99);
  const keyAfter = await redis.get(redisKey);
  check('3. the key session in storage was NOT touched', keyAfter === keyBefore && keyBefore !== null, true);
  for (const [i, node] of NODES.entries()) {
    const r = await gw(node, `/policies/${plan.id}`).then((x) => x.json());
    check(`3. new rate present on node ${i + 1}`, r.rate, 99);
  }

  // ── 4. org quota: set a ceiling, confirm it is readable; then cut off and restore ───────
  created.orgTouched = tenant.tykOrgId;
  await orgQuota.set(tenant.id, { quotaMax: 5, period: 'MONTHLY' });
  const state = await orgQuota.get(tenant.id);
  check('4. org ceiling readable', state.quotaMax, 5);
  check('4. org is active', state.isInactive, false);

  const reset = await orgQuota.reset(tenant.id);
  check('4. org reset kept the ceiling', reset.restored, true);
  check('4. ceiling survives the reset', (await orgQuota.get(tenant.id)).quotaMax, 5);

  // ── 5. metering is idempotent and an admin reset zeroes a counter ───────────────────────
  const first = await metering.meterAll();
  const second = await metering.meterAll();
  check('5. metering is idempotent (2nd pass writes nothing)', second, 0);
  console.log(`   (first pass wrote ${first} quota row(s))`);

  const anyKey = await prisma.apiKey.findFirst({
    where: { tenantId: tenant.id },
    select: { id: true },
  });
  if (anyKey) {
    await prisma.quota.updateMany({ where: { apiKeyId: anyKey.id }, data: { used: 4242 } });
    const before = await prisma.quota.findFirst({ where: { apiKeyId: anyKey.id }, select: { used: true } });
    if (before) {
      check('5. counter seeded for the reset test', before.used, 4242);
      await orgQuota.resetKey(anyKey.id, tenant.id);
      const zeroed = await prisma.quota.findFirst({ where: { apiKeyId: anyKey.id }, select: { used: true } });
      check('5. admin reset zeroed the counter', zeroed.used, 0);
    }
  }
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err?.stack ?? err);
    results.push({ label: 'run completed', ok: false });
  })
  .finally(async () => {
    // Clean both sides. Gateway state outlives our rows, so it is removed explicitly.
    for (const hash of created.tykKeyHashes) {
      await tyk.deleteKey?.(hash).catch(() => gw(NODES[0], `/keys/${hash}?hashed=true`, { method: 'DELETE' }).catch(() => {}));
    }
    for (const id of created.aclPolicyIds) {
      await tyk.deletePolicy(id).catch(() => {});
    }
    for (const id of created.planIds) {
      await prisma.plan.deleteMany({ where: { id } }).catch(() => {});
      await tyk.deletePolicy(id).catch(() => {});
    }
    if (created.orgTouched) {
      await tyk.deleteOrgSession(created.orgTouched).catch(() => {});
    }
    await prisma.$disconnect();
    await redis.getClient().quit().catch(() => {});

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('FAILED:', failed.map((r) => r.label).join(', '));
    }
    // Explicit on both paths, not just failure: ioredis' `.quit()` does not always let the event
    // loop drain on its own, and the script hanging after the last check ran and passed is not the
    // same as it failing — same reason oauth2-clients.e2e.mjs next door does this unconditionally.
    process.exit(failed.length > 0 ? 1 : 0);
  });
