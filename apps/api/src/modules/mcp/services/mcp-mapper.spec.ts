import {
  mapToTykMcp,
  mcpAclAccessRight,
  mcpLimitAccessRight,
  mcpPrimitiveLimits,
  mcpToolGrants,
  mcpUpstreamUrl,
  readTools,
  type McpTool,
} from './mcp-mapper';
import { buildTykKeyDef, buildKeyAclPolicy } from '../../keys/services/tyk-key-mapper';
import { buildPlanPolicy } from '../../plans/services/plan-policy';
import { QuotaPeriod } from '@prisma/client';

const TENANT = { slug: 'acme', tykOrgId: 'og-acme' };
const SOURCE = { name: 'Orders API', tykApiId: 'tyk-orders' };
const MCP_ID = 'og-mcp-1';

const GOLD = 'plan-gold';
const FREE = 'plan-free';

const tools: McpTool[] = [
  { operationId: 'getOrderStatus', name: 'get_order_status', description: 'Look one up.' },
  { operationId: 'refundOrder', name: 'refund_order', planId: GOLD, rateLimit: 10, ratePer: 60 },
  { operationId: 'listOrders', name: 'list_orders', rateLimit: 100, ratePer: 60 },
];

const server = { name: 'Orders MCP', listenPath: '/orders-mcp/', tools, tykApiId: MCP_ID };

describe('mapToTykMcp', () => {
  const doc = mapToTykMcp(server, SOURCE, TENANT);
  const gw = doc['x-tyk-api-gateway'] as Record<string, Record<string, unknown>>;

  it('pairs to the source API through the adapter loop URL, not a raw upstream', () => {
    // The whole reason `x-tyk-mcp-server` is accepted at all: anything else is refused with
    // "x-tyk-mcp-server is valid only for MCP proxies targeting a REST-as-MCP adapter".
    expect(gw.upstream).toEqual({ url: 'tyk://tyk-orders/mcp' });
    expect(mcpUpstreamUrl('tyk-orders')).toBe('tyk://tyk-orders/mcp');
  });

  it('stamps the tenant org, which is what makes the gateway refuse a cross-tenant pairing', () => {
    expect(gw.info.orgId).toBe('og-acme');
  });

  it('prefixes the listen path with the tenant slug, exactly as an API definition does', () => {
    expect(gw.server.listenPath).toEqual({ value: '/acme/orders-mcp/', strip: true });
  });

  it('is always authToken-protected — a keyless proxy could carry no tool grant', () => {
    expect(gw.server.authentication).toEqual({
      enabled: true,
      securitySchemes: { authToken: { enabled: true } },
    });
    expect(doc.security).toEqual([{ authToken: [] }]);
  });

  it('exposes every tool as an allowed primitive keyed by the source operationId', () => {
    expect(doc['x-tyk-mcp-server']).toEqual({
      primitives: [
        { source: { operationId: 'getOrderStatus' }, name: 'get_order_status', description: 'Look one up.', allow: true },
        { source: { operationId: 'refundOrder' }, name: 'refund_order', allow: true },
        { source: { operationId: 'listOrders' }, name: 'list_orders', allow: true },
      ],
    });
  });

  it('emits no REST paths of its own and no middleware block', () => {
    expect(doc.paths).toEqual({});
    // Deliberate: `middleware.mcpTools.<tool>.rateLimit` validates and round-trips but is never
    // enforced on 5.15.0 (13/13 calls served with rate 10). Emitting it would ship a limit that
    // silently does nothing; the real limit rides the plan policy's `mcp_primitives`.
    expect(gw.middleware).toBeUndefined();
  });
});

describe('mcpToolGrants (TBAC)', () => {
  it('gives a key on the bound plan every unbound tool plus that plan’s own', () => {
    expect(mcpToolGrants(tools, GOLD)).toEqual(['get_order_status', 'refund_order', 'list_orders']);
  });

  it('withholds a bound tool from a key on any other plan', () => {
    expect(mcpToolGrants(tools, FREE)).toEqual(['get_order_status', 'list_orders']);
  });

  it('treats a key with no plan the same as a key on the wrong plan', () => {
    expect(mcpToolGrants(tools, null)).toEqual(['get_order_status', 'list_orders']);
  });
});

describe('mcpPrimitiveLimits', () => {
  it('carries only the limited tools the plan actually grants', () => {
    expect(mcpPrimitiveLimits(tools, GOLD)).toEqual([
      { type: 'tool', name: 'refund_order', limit: { rate: 10, per: 60 } },
      { type: 'tool', name: 'list_orders', limit: { rate: 100, per: 60 } },
    ]);
  });

  it('drops a bound tool’s limit for a plan that does not grant it', () => {
    expect(mcpPrimitiveLimits(tools, FREE)).toEqual([
      { type: 'tool', name: 'list_orders', limit: { rate: 100, per: 60 } },
    ]);
  });

  it('ignores a tool with no limit configured', () => {
    expect(mcpPrimitiveLimits([tools[0]], GOLD)).toEqual([]);
  });
});

describe('the partition split', () => {
  // These two assertions are the ones that would catch the mistake that costs the most to find at
  // runtime: each field is accepted and stored on either side, and silently ignored on the wrong
  // one. `mcp_primitives` is read only by the rate_limit-partition owner (the plan's policy);
  // `mcp_access_rights` only by the acl-partition owner (the key's companion policy). Verified both
  // ways against Tyk 5.15.0 — see mcp-mapper.ts.
  it('keeps the grant off the plan side', () => {
    const entry = mcpLimitAccessRight(MCP_ID, 'Orders MCP', mcpPrimitiveLimits(tools, GOLD));
    expect(entry).toHaveProperty('mcp_primitives');
    expect(entry).not.toHaveProperty('mcp_access_rights');
  });

  it('keeps the limits off the key side', () => {
    const entry = mcpAclAccessRight(MCP_ID, 'Orders MCP', mcpToolGrants(tools, GOLD));
    expect(entry).toHaveProperty('mcp_access_rights');
    expect(entry).not.toHaveProperty('mcp_primitives');
  });

  it('puts the limits on the plan policy, which owns rate_limit and not acl', () => {
    const plan = {
      id: GOLD,
      name: 'Gold',
      rate: 50,
      per: 1,
      quotaMax: 1000,
      quotaPeriod: QuotaPeriod.MONTHLY,
      active: true,
    };
    const policy = buildPlanPolicy(plan, 'og-acme', {
      [MCP_ID]: mcpLimitAccessRight(MCP_ID, 'Orders MCP', mcpPrimitiveLimits(tools, GOLD)),
    });

    expect(policy.partitions).toEqual({
      quota: true,
      rate_limit: true,
      acl: false,
      complexity: false,
      per_api: false,
    });
    const rights = policy.access_rights as Record<string, Record<string, unknown>>;
    expect(rights[MCP_ID].mcp_primitives).toHaveLength(2);
  });

  it('puts the grant on the key’s ACL policy, which owns acl and not rate_limit', () => {
    const policy = buildKeyAclPolicy(
      'acl-1',
      [{ name: 'Orders MCP', tykApiId: MCP_ID, mcpTools: mcpToolGrants(tools, GOLD) }],
      'og-acme',
    );

    expect(policy?.partitions).toEqual({
      quota: false,
      rate_limit: false,
      acl: true,
      complexity: false,
      per_api: false,
    });
    const rights = policy?.access_rights as Record<string, Record<string, unknown>>;
    expect(rights[MCP_ID].mcp_access_rights).toEqual({
      tools: { allowed: ['get_order_status', 'refund_order', 'list_orders'] },
    });
  });
});

describe('key access rights', () => {
  it('carries both scopes when a key is scoped to an API and an MCP server', () => {
    const def = buildTykKeyDef(
      { name: 'k', planId: GOLD },
      [
        { name: 'Orders API', tykApiId: 'tyk-orders' },
        { name: 'Orders MCP', tykApiId: MCP_ID, mcpTools: mcpToolGrants(tools, GOLD) },
      ],
      'og-acme',
      1_700_000_000,
      'acl-1',
    );
    expect(def.apply_policies).toEqual([GOLD, 'acl-1']);
  });

  it('leaves a plain API scope untouched — no MCP field appears where none was asked for', () => {
    const def = buildTykKeyDef({ name: 'k' }, { name: 'Orders API', tykApiId: 'tyk-orders' }, 'og-acme');
    const rights = def.access_rights as Record<string, Record<string, unknown>>;
    expect(rights['tyk-orders']).toEqual({
      api_id: 'tyk-orders',
      api_name: 'Orders API',
      versions: ['Default'],
    });
  });

  it('grants no tool at all when the key’s plan matches none of the bindings', () => {
    // Not the same as omitting the field: an empty allow list is the refusal, and the gateway both
    // answers 403 and hides the tool from this key's `tools/list`.
    const def = buildTykKeyDef(
      { name: 'k' },
      [{ name: 'Orders MCP', tykApiId: MCP_ID, mcpTools: [] }],
      'og-acme',
    );
    const rights = def.access_rights as Record<string, Record<string, unknown>>;
    expect(rights[MCP_ID].mcp_access_rights).toEqual({ tools: { allowed: [] } });
  });
});

describe('readTools', () => {
  it('reads a well-formed column back unchanged', () => {
    expect(readTools(tools)).toEqual(tools);
  });

  it('drops entries that could not name a primitive, rather than failing the whole sync', () => {
    const raw = [
      { operationId: 'ok', name: 'ok_tool' },
      { operationId: 'missing-name' },
      { name: 'missing-operation' },
      null,
      'not an object',
      ['nor this'],
    ];
    expect(readTools(raw as unknown as never)).toEqual([{ operationId: 'ok', name: 'ok_tool' }]);
  });

  it('returns nothing for a null or non-array column', () => {
    expect(readTools(null)).toEqual([]);
    expect(readTools({ tools: [] } as unknown as never)).toEqual([]);
  });
});
