/**
 * WP28 acceptance, end to end against the live gateway and real Postgres.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:mcp
 *
 * Same shape and same reason as plans-quotas.e2e.mjs next door: it runs INSIDE the api container,
 * drives the compiled services out of dist/ and talks to Tyk's control API (8081, unpublished) and
 * to the data plane (8080) through the real Prisma client. Requires a current api image
 * (`docker compose up -d --build api`) — it reads dist/, so a stale image tests stale code.
 *
 * It proves the three things unit tests structurally cannot, because each one is a claim about what
 * the GATEWAY does, not about what this codebase emits:
 *
 *   1. an MCP server is registered and appears in the catalogue — ours and the gateway's — and its
 *      tools are really callable over JSON-RPC
 *   2. a call is rate limited PER PRIMITIVE: the 11th call to the limited tool in the window is 429
 *      while an unlimited tool on the same server, same key, same session keeps answering 200
 *   3. TBAC: a key whose plan does not carry the tool gets 403, and does not even see the tool in
 *      `tools/list`
 *
 * Everything it creates is removed in the `finally` block, including on the gateway, which outlives
 * our rows. The upstream is the api container's own `/health` — no extra service to start, and the
 * one endpoint guaranteed to be up whenever this script can run at all.
 */
import { createRequire } from 'node:module';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const { prisma } = require('@open-gateway/database');
const { McpService } = require(`${ROOT}/modules/mcp/services/mcp.service.js`);
const { PlanService } = require(`${ROOT}/modules/plans/services/plan.service.js`);
const { KeyService } = require(`${ROOT}/modules/keys/services/key.service.js`);
const { QuotaService } = require(`${ROOT}/modules/quotas/services/quota.service.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { RedisService } = require(`${ROOT}/common/redis/redis.service.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const redis = new RedisService(config);
const tyk = new TykClientService(config, new CircuitBreakerService(), redis);
const mcp = new McpService(tyk);
const plans = new PlanService(tyk, mcp);
const keys = new KeyService(tyk, new QuotaService(), mcp);

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const ADMIN = process.env.TYK_ADMIN_URL ?? 'http://tyk-gateway:8081/tyk';
const DATA = 'http://tyk-gateway:8080';
const UPSTREAM = 'http://api:4000';

const SUFFIX = Date.now().toString(36);
const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
};

const gw = (path, init = {}) =>
  fetch(`${ADMIN}${path}`, { ...init, headers: { 'x-tyk-authorization': SECRET, ...(init.headers ?? {}) } });

const created = { apiIds: [], mcpIds: [], planIds: [], keyIds: [] };

/** A minimal MCP client over Tyk's streamable-HTTP transport: `POST {listenPath}/mcp`. */
function mcpClient(endpoint, token) {
  let sessionId = null;
  return async (method, params) => {
    const res = await fetch(`${DATA}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        Authorization: token,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* a gateway-level refusal (401, edge error) is not JSON-RPC; `status` is what matters then */
    }
    return { status: res.status, body, text };
  };
}

const handshake = async (call) =>
  call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'wp28-e2e', version: '1.0.0' },
  });

async function main() {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, slug: true, tykOrgId: true } });
  if (!tenant) throw new Error('no tenant seeded');
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error('no user seeded');
  console.log(`tenant ${tenant.slug} org=${tenant.tykOrgId}\n`);

  // ── 0. the paired source API: a plain OAS proxy with two named operations ───────────────
  //
  // The row is written directly rather than through ApiService, and the gateway document is pushed
  // by hand, for one reason: the product's own OAS mapper emits a catch-all `/{wildcard}` path, and
  // a catch-all has no per-operation `operationId` for an MCP tool to point at. Tyk derives every
  // tool's input and output schema from the SOURCE document, so the tool catalogue is only ever as
  // good as that document — which is a real constraint on WP28, recorded here rather than papered
  // over. WP28 does not own the OAS mapper, so widening it is not this script's business.
  const sourceTykId = `og-wp28-src-${SUFFIX}`;
  const source = await prisma.apiDefinition.create({
    data: {
      tenantId: tenant.id,
      name: `WP28 Source ${SUFFIX}`,
      slug: `wp28-src-${SUFFIX}`,
      listenPath: `/wp28-src-${SUFFIX}/`,
      proxyUrl: UPSTREAM,
      authType: 'NONE',
      status: 'ACTIVE',
      defFormat: 'OAS',
      tykApiId: sourceTykId,
      syncStatus: 'SYNCED',
    },
  });
  created.apiIds.push(source.id);

  const row = { tykApiId: sourceTykId, listenPath: source.listenPath };
  const listen = `/${tenant.slug}${row.listenPath}`;
  const sourceDoc = {
    openapi: '3.0.3',
    info: { title: `WP28 Source ${SUFFIX}`, version: '1.0.0' },
    paths: {
      '/health': {
        get: {
          operationId: 'checkHealth',
          summary: 'Report service health',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } },
            },
          },
        },
      },
      '/health/ready': {
        get: {
          operationId: 'checkReady',
          summary: 'Report readiness',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } },
            },
          },
        },
      },
    },
    'x-tyk-api-gateway': {
      info: { id: row.tykApiId, name: `WP28 Source ${SUFFIX}`, orgId: tenant.tykOrgId, state: { active: true } },
      upstream: { url: UPSTREAM },
      server: { listenPath: { value: listen, strip: true }, authentication: { enabled: false } },
    },
  };
  await tyk.upsertOasApi(sourceDoc);

  // The pairing check reads the LOADED spec, not the stored one — an MCP proxy pushed before the
  // source's reload lands is validated against the source's PREVIOUS state and refused
  // ("Paired REST API belongs to a different OrgID"). `upsertOasApi` reloads before returning, so
  // ordering the two calls is what makes this safe; this settle is belt and braces on a busy node.
  await new Promise((r) => setTimeout(r, 1500));

  // ── 1. register the MCP server ──────────────────────────────────────────────────────────
  const gold = await plans.create(
    { name: `WP28 Gold ${SUFFIX}`, rate: 0, per: 0, quotaMax: -1, quotaPeriod: 'MONTHLY' },
    tenant.id,
  );
  const free = await plans.create(
    { name: `WP28 Free ${SUFFIX}`, rate: 0, per: 0, quotaMax: -1, quotaPeriod: 'MONTHLY' },
    tenant.id,
  );
  created.planIds.push(gold.id, free.id);

  const server = await mcp.create(
    {
      name: `WP28 MCP ${SUFFIX}`,
      slug: `wp28-mcp-${SUFFIX}`,
      listenPath: `/wp28-mcp-${SUFFIX}/`,
      sourceApiId: source.id,
      tools: [
        // Bound to Gold AND limited: this single tool carries both acceptance criteria.
        { operationId: 'checkHealth', name: 'check_health', description: 'Service health', planId: gold.id, rateLimit: 10, ratePer: 60 },
        // Unbound and unlimited: the control. Proves the limit is per-primitive rather than
        // per-server, and that TBAC withholds one tool without withholding the whole catalogue.
        { operationId: 'checkReady', name: 'check_ready', description: 'Readiness' },
      ],
    },
    tenant.id,
  );
  created.mcpIds.push(server.id);

  check('1. MCP server registered', server.syncStatus, 'SYNCED');
  check('1. listed in our own catalogue', (await mcp.findAll(tenant.id)).some((s) => s.id === server.id), true);

  const catalogue = await gw('/mcps').then((r) => r.json());
  check(
    "1. present in the gateway's /tyk/mcps catalogue",
    catalogue.some((d) => d['x-tyk-api-gateway']?.info?.id === server.tykApiId),
    true,
  );
  const stored = await gw(`/mcps/${server.tykApiId}`).then((r) => r.json());
  check('1. paired to the source API through the adapter loop URL', stored['x-tyk-api-gateway'].upstream.url, `tyk://${row.tykApiId}/mcp`);
  check('1. two primitives stored', stored['x-tyk-mcp-server'].primitives.length, 2);

  // The plan policies are re-pushed after the server exists, so they pick up its mcp_primitives.
  // (A plan created before its first MCP server has nothing to carry yet — this is the same
  // `syncPolicy` an operator would run, not a workaround.)
  await plans.syncPolicy(gold.id, tenant.id);
  await plans.syncPolicy(free.id, tenant.id);
  const goldPolicy = await gw(`/policies/${gold.id}`).then((r) => r.json());
  check(
    '1. the Gold policy carries the per-primitive limit',
    JSON.stringify(goldPolicy.access_rights?.[server.tykApiId]?.mcp_primitives),
    JSON.stringify([{ type: 'tool', name: 'check_health', limit: { rate: 10, per: 60 } }]),
  );

  // ── keys ────────────────────────────────────────────────────────────────────────────────
  const goldKey = await keys.create(
    { name: `wp28-gold-${SUFFIX}`, mcpServerId: server.id, planId: gold.id },
    tenant.id,
    user.id,
  );
  const freeKey = await keys.create(
    { name: `wp28-free-${SUFFIX}`, mcpServerId: server.id, planId: free.id },
    tenant.id,
    user.id,
  );
  created.keyIds.push(goldKey.id, freeKey.id);

  const endpoint = server.endpoint;
  console.log(`\nMCP endpoint ${endpoint}\n`);

  // ── unauthenticated ─────────────────────────────────────────────────────────────────────
  const anon = await fetch(`${DATA}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('1. the proxy refuses an unauthenticated client', anon.status, 401);

  // ── 2. per-primitive rate limit ─────────────────────────────────────────────────────────
  const asGold = mcpClient(endpoint, goldKey.keyValue);
  check('2. initialize', (await handshake(asGold)).status, 200);

  const goldTools = (await asGold('tools/list', {})).body.result.tools.map((t) => t.name).sort();
  check('2. Gold sees both tools', JSON.stringify(goldTools), JSON.stringify(['check_health', 'check_ready']));

  let firstRefusal = 0;
  let refusalCode = null;
  for (let i = 1; i <= 13; i += 1) {
    const r = await asGold('tools/call', { name: 'check_health', arguments: {} });
    if (r.status !== 200) {
      firstRefusal = i;
      refusalCode = r.body?.error?.code ?? null;
      break;
    }
  }
  check('2. the 11th call to the limited tool is refused', firstRefusal, 11);
  check('2. refused as a rate limit (JSON-RPC -32003)', refusalCode, -32003);

  // The control. Same key, same session, same server — so a 200 here can only mean the limit was
  // scoped to the primitive, not applied to the MCP server as a whole.
  const control = await asGold('tools/call', { name: 'check_ready', arguments: {} });
  check('2. the unlimited tool on the same key still answers', control.status, 200);

  // ── 3. TBAC ─────────────────────────────────────────────────────────────────────────────
  const asFree = mcpClient(endpoint, freeKey.keyValue);
  check('3. initialize on the Free key', (await handshake(asFree)).status, 200);

  const freeTools = (await asFree('tools/list', {})).body.result.tools.map((t) => t.name);
  check('3. the bound tool is hidden from a key without the plan', JSON.stringify(freeTools), JSON.stringify(['check_ready']));

  const denied = await asFree('tools/call', { name: 'check_health', arguments: {} });
  check('3. a key without the plan is refused the bound tool', denied.status, 403);
  check('3. refused as an access decision (JSON-RPC -32002)', denied.body?.error?.code, -32002);

  const allowed = await asFree('tools/call', { name: 'check_ready', arguments: {} });
  check('3. the same key may still call an unbound tool', allowed.status, 200);

  // ── 4. re-binding takes effect on a credential that already exists ──────────────────────
  //
  // The half of TBAC that is easy to ship broken: the grant lives in the key's companion ACL policy,
  // written when the key was created. Without McpService.update re-pushing it, withdrawing a
  // binding would change the catalogue and leave every existing key still able to call the tool.
  await mcp.update(
    server.id,
    {
      tools: [
        { operationId: 'checkHealth', name: 'check_health', description: 'Service health', planId: gold.id, rateLimit: 10, ratePer: 60 },
        { operationId: 'checkReady', name: 'check_ready', description: 'Readiness', planId: gold.id },
      ],
    },
    tenant.id,
  );
  await new Promise((r) => setTimeout(r, 1500));

  const afterRebind = mcpClient(endpoint, freeKey.keyValue);
  await handshake(afterRebind);
  const revoked = await afterRebind('tools/call', { name: 'check_ready', arguments: {} });
  check('4. binding a tool to another plan revokes it on an existing key', revoked.status, 403);
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err?.stack ?? err);
    results.push({ label: 'run completed', ok: false });
  })
  .finally(async () => {
    for (const id of created.keyIds) {
      const key = await prisma.apiKey.findUnique({ where: { id }, select: { tenantId: true } }).catch(() => null);
      if (key) await keys.revoke(id, key.tenantId).catch(() => {});
      await prisma.quota.deleteMany({ where: { apiKeyId: id } }).catch(() => {});
      await prisma.apiKey.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of created.mcpIds) {
      const row = await prisma.mcpServer.findUnique({ where: { id }, select: { tenantId: true } }).catch(() => null);
      if (row) await mcp.remove(id, row.tenantId).catch(() => {});
      await prisma.mcpServer.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of created.planIds) {
      await prisma.plan.deleteMany({ where: { id } }).catch(() => {});
      await tyk.deletePolicy(id).catch(() => {});
    }
    for (const id of created.apiIds) {
      const row = await prisma.apiDefinition.findUnique({ where: { id }, select: { tykApiId: true } }).catch(() => null);
      if (row?.tykApiId) await tyk.deleteOasApi(row.tykApiId).catch(() => {});
      await prisma.apiDefinition.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
    await redis.getClient().quit().catch(() => {});

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) console.log('FAILED:', failed.map((r) => r.label).join(', '));
    // Explicit on both paths: ioredis' `.quit()` does not always let the event loop drain, and the
    // script hanging after the last check passed is not the same as it failing.
    process.exit(failed.length > 0 ? 1 : 0);
  });
