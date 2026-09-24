import type { Prisma } from '@prisma/client';
import { gatewayListenPath } from '../../api-management/services/tyk-mappers';
import type { McpToolDto } from '../dto/mcp-tool.dto';

/**
 * Everything this product knows about Tyk 5.15.0 OSS's REST-as-MCP support, in one place.
 *
 * All of it was established against a live gateway with no Dashboard anywhere in the path (spike S3
 * and WP28's own probes); none of it is inferred from documentation. The four findings that shape
 * the code below:
 *
 *  1. **An MCP proxy is paired, not standalone.** `x-tyk-mcp-server` is refused
 *     ("x-tyk-mcp-server is valid only for MCP proxies targeting a REST-as-MCP adapter") unless
 *     `upstream.url` is `tyk://<sourceTykApiId>/mcp`. The source must be an OAS API — a Classic one
 *     is refused with "REST-as-MCP sources must be Tyk OAS APIs" — and must already be LOADED on the
 *     node, not merely stored: the pairing check reads the loaded spec, so an MCP proxy pushed in the
 *     same breath as a brand-new source API is validated against the *previous* version of it.
 *  2. **Pairing is org-scoped by the gateway** — "Paired REST API belongs to a different OrgID".
 *     Tenant isolation therefore holds at the gateway too, not only in this service's WHERE clauses.
 *  3. **`middleware.mcpTools.<tool>.rateLimit` does not work.** It validates, it round-trips through
 *     `GET /tyk/mcps/{id}` unchanged, and it is never enforced: 13/13 calls served with `rate: 10`.
 *     Per-primitive limits are delivered through the POLICY instead (`mcp_primitives`), which does
 *     work. This mapper emits no `middleware` block at all rather than emit a decorative one.
 *  4. **The two policy-side MCP fields follow their own partitions**, which is what makes them fit
 *     WP18's two-policy design exactly:
 *       - `mcp_primitives` (per-primitive rate limit) is honoured only by the policy that owns the
 *         `rate_limit` partition — the PLAN's policy.
 *       - `mcp_access_rights` (TBAC) is honoured only by the policy that owns the `acl` partition —
 *         the KEY's companion ACL policy.
 *     Put either on the wrong side and it is accepted, stored, and silently ignored (verified both
 *     ways). A key with no plan at all carries both inline on its own session, which is unpartitioned
 *     and therefore honours both.
 *
 * The data plane is `POST {listenPath}/mcp`, streamable HTTP, JSON-RPC. A denied tool answers
 * `-32002` / http 403; a rate-limited one `-32003` / http 429.
 */

/** `McpServer.tools` is a JSON column; this is the shape written into it. */
export type McpTool = McpToolDto;

/** Tyk's own name for the synthetic adapter it builds from the paired API, used for the loop URL. */
export const mcpUpstreamUrl = (sourceTykApiId: string): string => `tyk://${sourceTykApiId}/mcp`;

/** Only tools today — see `McpToolDto`'s note on resources and prompts. */
const PRIMITIVE_TYPE = 'tool';

/**
 * Read the `tools` JSON column back as a typed list.
 *
 * Tolerant on purpose: the column is written only by this service through a validated DTO, but a
 * row could predate a field or have been touched by hand, and a malformed entry must not take the
 * whole server's sync down. Entries without the two fields that are structurally required
 * (`operationId`, `name`) are dropped.
 */
export function readTools(value: Prisma.JsonValue | McpTool[] | null): McpTool[] {
  if (!Array.isArray(value)) return [];

  const valid: McpTool[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.operationId !== 'string' || typeof t.name !== 'string') continue;
    // The column is only ever written from a validated `McpToolDto`, so the narrowing above is the
    // real check and this cast carries no further claim; `JsonValue` simply has no structural
    // overlap with a class type for the compiler to verify against.
    valid.push(entry as unknown as McpTool);
  }
  return valid;
}

/**
 * Which of this server's tools a key on `planId` may call.
 *
 * A tool with no `planId` is open to every key scoped to the server; a bound tool is callable only
 * by a key on that exact plan. `planId` is the KEY's plan — `null` for a key that has none, which
 * therefore sees only the unbound tools. This is the whole of TBAC: the result becomes
 * `mcp_access_rights.tools.allowed`, and the gateway both refuses (403) and hides (filters
 * `tools/list`) anything absent from it.
 */
export function mcpToolGrants(tools: McpTool[], planId: string | null): string[] {
  return tools.filter((t) => !t.planId || t.planId === planId).map((t) => t.name);
}

/** The `mcp_primitives` entries for the tools a plan grants that also carry a per-tool limit. */
export function mcpPrimitiveLimits(
  tools: McpTool[],
  planId: string | null,
): { type: string; name: string; limit: { rate: number; per: number } }[] {
  const limits: { type: string; name: string; limit: { rate: number; per: number } }[] = [];
  for (const { planId: bound, name, rateLimit, ratePer } of tools) {
    if (bound && bound !== planId) continue;
    if (!rateLimit || !ratePer) continue;
    limits.push({ type: PRIMITIVE_TYPE, name, limit: { rate: rateLimit, per: ratePer } });
  }
  return limits;
}

/** The shared head of an `access_rights` entry for an MCP proxy. */
const accessHead = (tykApiId: string, name: string): Record<string, unknown> => ({
  api_id: tykApiId,
  api_name: name,
  versions: ['Default'],
});

/**
 * The `access_rights` entry that grants tools — for the ACL-owning side (a key's companion policy,
 * or an unplanned key's own inline session).
 */
export function mcpAclAccessRight(
  tykApiId: string,
  name: string,
  allowedTools: string[],
): Record<string, unknown> {
  return {
    ...accessHead(tykApiId, name),
    // `blocked` is left out rather than sent empty: with a non-empty allow list it is dead weight,
    // and Tyk drops it from the stored policy anyway.
    mcp_access_rights: { tools: { allowed: allowedTools } },
  };
}

/**
 * The `access_rights` entry that carries per-primitive limits — for the rate-limit-owning side (a
 * plan's policy). It deliberately carries no `mcp_access_rights`: the plan policy has
 * `partitions.acl: false`, so a grant placed here would be stored and never read (WP18's reasoning
 * for keeping plans ACL-less applies unchanged to MCP).
 */
export function mcpLimitAccessRight(
  tykApiId: string,
  name: string,
  primitives: ReturnType<typeof mcpPrimitiveLimits>,
): Record<string, unknown> {
  return { ...accessHead(tykApiId, name), mcp_primitives: primitives };
}

export interface McpTenantScope {
  slug: string;
  tykOrgId: string;
}

export interface McpSourceApi {
  name: string;
  tykApiId: string;
}

/**
 * What the mapper needs from an `McpServer` row. Spelled out rather than `Pick<McpServer, …>` so
 * `tools` can be either the raw JSON column or an already-parsed list — the service passes the
 * column, tests pass the list, and `readTools` accepts both.
 */
export interface McpServerInput {
  name: string;
  listenPath: string;
  tools: Prisma.JsonValue | McpTool[];
  tykApiId: string;
}

/**
 * The Tyk-OAS document for an MCP proxy, as `POST|PUT /tyk/mcps` accepts it.
 *
 * `paths` is empty by design: the proxy exposes no REST surface of its own, only the JSON-RPC MCP
 * endpoint the adapter mounts. The tool catalogue lives entirely in `x-tyk-mcp-server.primitives`,
 * and Tyk derives each tool's input and output schema from the SOURCE document's operation — which
 * is why a source operation with no response schema produces a tool with no `outputSchema`, and why
 * nothing here needs to restate the source's parameters.
 *
 * Authentication is always `authToken` and is not configurable. An MCP proxy is a distinct consumer
 * of its source API with its own credential (Tyk's own model), and TBAC is expressed through key
 * policies — a keyless MCP proxy could not carry tool grants at all, so offering the choice would
 * mean offering a configuration in which this WP's access control silently does nothing.
 */
export function mapToTykMcp(
  server: McpServerInput,
  source: McpSourceApi,
  tenant: McpTenantScope,
): Record<string, unknown> {
  const tools = readTools(server.tools);

  return {
    openapi: '3.0.3',
    info: { title: server.name, version: '1.0.0' },
    paths: {},
    components: {
      securitySchemes: { authToken: { type: 'apiKey', in: 'header', name: 'Authorization' } },
    },
    security: [{ authToken: [] }],
    'x-tyk-api-gateway': {
      info: {
        id: server.tykApiId,
        name: server.name,
        orgId: tenant.tykOrgId,
        state: { active: true },
      },
      upstream: { url: mcpUpstreamUrl(source.tykApiId) },
      server: {
        listenPath: { value: gatewayListenPath(tenant.slug, server.listenPath), strip: true },
        authentication: { enabled: true, securitySchemes: { authToken: { enabled: true } } },
      },
    },
    'x-tyk-mcp-server': {
      primitives: tools.map((t) => ({
        source: { operationId: t.operationId },
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        allow: true,
      })),
    },
  };
}
