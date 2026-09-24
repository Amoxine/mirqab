import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApiDefFormat, ApiSyncStatus, Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { TykClientService, type NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import { gatewayListenPath } from '../../api-management/services/tyk-mappers';
import { CreateMcpServerDto, UpdateMcpServerDto } from '../dto/mcp-server.dto';
import type { McpToolDto } from '../dto/mcp-tool.dto';
import {
  mapToTykMcp,
  mcpAclAccessRight,
  mcpLimitAccessRight,
  mcpPrimitiveLimits,
  mcpToolGrants,
  readTools,
  type McpTool,
} from './mcp-mapper';

/** Response shape for every `/mcps` route. */
export interface McpServerDetail {
  id: string;
  name: string;
  slug: string;
  sourceApiId: string;
  sourceApiName: string;
  listenPath: string;
  /** What a client actually calls, tenant prefix and `/mcp` suffix included. */
  endpoint: string;
  tools: McpTool[];
  tykApiId: string | null;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const withSource = {
  sourceApi: { select: { id: true, name: true, tykApiId: true, defFormat: true } },
} satisfies Prisma.McpServerInclude;
type McpServerRow = Prisma.McpServerGetPayload<{ include: typeof withSource }>;

/** The MCP endpoint a client POSTs JSON-RPC to. */
export const mcpEndpoint = (tenantSlug: string, listenPath: string): string =>
  `${gatewayListenPath(tenantSlug, listenPath).replace(/\/$/, '')}/mcp`;

function toDetail(row: McpServerRow, tenantSlug: string): McpServerDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sourceApiId: row.sourceApiId,
    sourceApiName: row.sourceApi.name,
    listenPath: row.listenPath,
    endpoint: mcpEndpoint(tenantSlug, row.listenPath),
    tools: readTools(row.tools),
    tykApiId: row.tykApiId,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const takenBy = (field: string, value: string): string =>
  `An MCP server with ${field} "${value}" already exists in this tenant.`;

/**
 * MCP servers (WP28): registration, the tool catalogue, and the two policy fragments that make
 * per-primitive rate limits and TBAC work. See `mcp-mapper.ts` for everything this depends on about
 * Tyk 5.15.0's REST-as-MCP support and how it was established.
 *
 * No new permission family: every route reuses `api:*` (an MCP proxy is an API this tenant
 * publishes) and reading a tool's plan binding reuses `plan:read`.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(private readonly tykClient: TykClientService) {}

  async create(dto: CreateMcpServerDto, tenantId: string): Promise<McpServerDetail> {
    const source = await this.loadSource(dto.sourceApiId, tenantId);
    await this.assertToolsValid(dto.tools ?? [], tenantId);

    let row: McpServerRow;
    try {
      row = await prisma.mcpServer.create({
        data: {
          tenantId,
          sourceApiId: source.id,
          name: dto.name,
          slug: dto.slug,
          listenPath: dto.listenPath,
          tools: (dto.tools ?? []) as unknown as Prisma.InputJsonValue,
          // Generated here, not on first sync: it is the gateway id every policy fragment and every
          // key's access rights reference, so it has to exist before anything can be granted.
          tykApiId: `og-mcp-${randomUUID()}`,
        },
        include: withSource,
      });
    } catch (err) {
      throw this.asConflict(err, dto.slug, dto.listenPath);
    }

    await this.sync(row);
    return this.findOne(row.id, tenantId);
  }

  async findAll(tenantId: string): Promise<McpServerDetail[]> {
    const { slug } = await loadTenantScope(tenantId);
    const rows = await prisma.mcpServer.findMany({
      where: { tenantId },
      include: withSource,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toDetail(r, slug));
  }

  async findOne(id: string, tenantId: string): Promise<McpServerDetail> {
    const { slug } = await loadTenantScope(tenantId);
    return toDetail(await this.findRow(id, tenantId), slug);
  }

  /**
   * Edit the server and re-push it — and, when the tool catalogue changed, re-push every affected
   * key's ACL policy too.
   *
   * That second half is not optional housekeeping. A key's tool grant is baked into its companion
   * ACL policy at creation time (it has to be: only the ACL-partition owner's `mcp_access_rights`
   * is read, and a plan's policy cannot own ACL). Without this, re-binding a tool to a different
   * plan would change the catalogue and leave every existing key still able to call it — a
   * withdrawn grant that keeps working is the worst possible outcome for an access-control feature.
   */
  async update(id: string, dto: UpdateMcpServerDto, tenantId: string): Promise<McpServerDetail> {
    const current = await this.findRow(id, tenantId);
    if (dto.tools) await this.assertToolsValid(dto.tools, tenantId);

    let row: McpServerRow;
    try {
      row = await prisma.mcpServer.update({
        where: { id },
        data: {
          name: dto.name,
          slug: dto.slug,
          listenPath: dto.listenPath,
          ...(dto.tools ? { tools: dto.tools as unknown as Prisma.InputJsonValue } : {}),
        },
        include: withSource,
      });
    } catch (err) {
      throw this.asConflict(err, dto.slug ?? current.slug, dto.listenPath ?? current.listenPath);
    }

    await this.sync(row);
    if (dto.tools) await this.refreshKeyGrants(row);

    return this.findOne(id, tenantId);
  }

  /**
   * Delete the server and its gateway proxy. Keys scoped to it survive with `mcpServerId` nulled by
   * the FK — same reasoning as a deleted plan: a commercial or structural decision must not destroy
   * live credentials. Their ACL policies lose the grant on their next rebuild, and in the meantime
   * the proxy they pointed at no longer exists, so nothing is reachable through them.
   */
  async remove(id: string, tenantId: string): Promise<{ message: string; nodes: NodeOutcome[] }> {
    const row = await this.findRow(id, tenantId);

    const nodes = row.tykApiId ? await this.tykClient.deleteMcp(row.tykApiId) : [];
    await prisma.mcpServer.delete({ where: { id } });

    return { message: `MCP server "${row.name}" deleted.`, nodes };
  }

  /** Re-push one server to every node, for drift repair and for the per-node assertion. */
  async syncNow(id: string, tenantId: string): Promise<{ detail: McpServerDetail; nodes: NodeOutcome[] }> {
    const row = await this.findRow(id, tenantId);
    const nodes = await this.sync(row);
    return { detail: await this.findOne(id, tenantId), nodes };
  }

  // ---------------------------------------------------------------------------
  // Policy fragments — consumed by PlanService and KeyService
  // ---------------------------------------------------------------------------

  /**
   * `access_rights` entries a PLAN's policy must carry: the per-primitive rate limits of every tool
   * that plan grants, across every MCP server in the tenant.
   *
   * On the plan's policy because `mcp_primitives` is honoured only by the policy that owns the
   * `rate_limit` partition — which for a plan-governed key is the plan's, by WP18's design. Servers
   * with no limited tool contribute nothing, so a tenant that never configures a limit gets exactly
   * the `access_rights: {}` WP18 already produced.
   */
  async planAccessRights(tenantId: string, planId: string): Promise<Record<string, unknown>> {
    const rows = await prisma.mcpServer.findMany({
      where: { tenantId, tykApiId: { not: null } },
      select: { name: true, tykApiId: true, tools: true },
    });

    const entries: Record<string, unknown> = {};
    for (const { name, tykApiId, tools } of rows) {
      if (!tykApiId) continue;
      const primitives = mcpPrimitiveLimits(readTools(tools), planId);
      if (primitives.length > 0) entries[tykApiId] = mcpLimitAccessRight(tykApiId, name, primitives);
    }
    return entries;
  }

  /**
   * The single `access_rights` entry a KEY scoped to `mcpServerId` needs — the tools its plan
   * grants. Null when the server is unknown to this tenant or has never synced.
   *
   * `planId` is the key's plan, `null` for a key that has none: such a key sees only the tools that
   * are bound to no plan at all, which is what "a key without that plan is refused" means at the
   * bottom of the range as well as the top.
   */
  async keyAccessRight(
    mcpServerId: string,
    tenantId: string,
    planId: string | null,
  ): Promise<{ scope: { name: string; tykApiId: string; mcpTools: string[] } } | null> {
    const row = await prisma.mcpServer.findFirst({
      where: { id: mcpServerId, tenantId },
      select: { name: true, tykApiId: true, tools: true },
    });
    if (!row?.tykApiId) return null;

    return {
      scope: {
        name: row.name,
        tykApiId: row.tykApiId,
        mcpTools: mcpToolGrants(readTools(row.tools), planId),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async findRow(id: string, tenantId: string): Promise<McpServerRow> {
    const row = await prisma.mcpServer.findFirst({ where: { id, tenantId }, include: withSource });
    if (!row) throw new NotFoundException(`MCP server ${id} not found`);
    return row;
  }

  /** The paired source API must exist in this tenant, be OAS-format, and already be on the gateway. */
  private async loadSource(
    sourceApiId: string,
    tenantId: string,
  ): Promise<{ id: string; name: string; tykApiId: string }> {
    const api = await prisma.apiDefinition.findFirst({
      where: { id: sourceApiId, tenantId },
      select: { id: true, name: true, tykApiId: true, defFormat: true },
    });
    if (!api) throw new BadRequestException(`API ${sourceApiId} not found in this tenant`);

    // Both refusals below are the gateway's own, restated here so the caller gets a 400 that names
    // the cause instead of a 502 carrying "REST-as-MCP sources must be Tyk OAS APIs".
    if (api.defFormat !== ApiDefFormat.OAS) {
      throw new BadRequestException(
        'An MCP server can only be paired to an OAS-format API — Tyk builds the tool catalogue from ' +
          'its OpenAPI document, and a CLASSIC definition has none.',
      );
    }
    if (!api.tykApiId) {
      throw new BadRequestException('The source API is not synced to the gateway yet, try again in a moment');
    }
    return { id: api.id, name: api.name, tykApiId: api.tykApiId };
  }

  /**
   * Tool names are unique within a server, and a bound plan must belong to this tenant.
   *
   * The plan check is the same one `KeyService` makes for `planId`, and for the same reason: without
   * it a caller could name another tenant's plan id and bind a tool to limits and grants it does
   * not own.
   */
  private async assertToolsValid(tools: McpToolDto[], tenantId: string): Promise<void> {
    const names = tools.map((t) => t.name);
    const duplicate = names.find((n, i) => names.indexOf(n) !== i);
    if (duplicate) {
      throw new BadRequestException(`Duplicate tool name "${duplicate}" — tool names must be unique.`);
    }

    const planIds = [...new Set(tools.map((t) => t.planId).filter((p): p is string => !!p))];
    if (planIds.length === 0) return;

    const found = await prisma.plan.findMany({
      where: { id: { in: planIds }, tenantId },
      select: { id: true },
    });
    const missing = planIds.filter((id) => !found.some((p) => p.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(`Plan ${missing[0]} not found in this tenant`);
    }
  }

  /**
   * Push the definition to every node.
   *
   * Awaited, not fire-and-forget like an API definition's background sync: an MCP server whose proxy
   * is not on the gateway is not "pending", it is a catalogue entry pointing at a listen path that
   * answers 404. The outcome is recorded either way so a partial fan-out is visible rather than
   * reported as success.
   */
  private async sync(row: McpServerRow): Promise<NodeOutcome[]> {
    const tenant = await loadTenantScope(row.tenantId);
    const source = row.sourceApi;

    // Both ids are non-null in every path that reaches here — `create` generates `tykApiId` up
    // front and `loadSource` refuses an unsynced source — but a row edited out of band could still
    // carry neither, and a mapper that produced `tyk://null/mcp` would fail obscurely on the node.
    if (!source.tykApiId || !row.tykApiId) {
      await this.markFailed(row.id, 'The source API is not synced to the gateway');
      return [];
    }
    const tykApiId = row.tykApiId;

    let nodes: NodeOutcome[];
    try {
      nodes = await this.tykClient.upsertMcp(
        mapToTykMcp(
          { name: row.name, listenPath: row.listenPath, tools: row.tools, tykApiId },
          { name: source.name, tykApiId: source.tykApiId },
          tenant,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`MCP server ${row.id} failed to sync: ${message}`);
      await this.markFailed(row.id, message);
      return [];
    }

    const failed = nodes.filter((n) => !n.ok);
    await prisma.mcpServer.update({
      where: { id: row.id },
      data:
        failed.length > 0
          ? { syncStatus: ApiSyncStatus.FAILED, syncError: failed.map((n) => n.error).join('; ') }
          : { syncStatus: ApiSyncStatus.SYNCED, syncError: null, lastSyncedAt: new Date() },
    });

    return nodes;
  }

  private async markFailed(id: string, syncError: string): Promise<void> {
    await prisma.mcpServer.update({
      where: { id },
      data: { syncStatus: ApiSyncStatus.FAILED, syncError },
    });
  }

  /**
   * Re-push the companion ACL policy of every key scoped to this server, so a changed tool binding
   * takes effect on credentials that already exist. Keys with no ACL policy (no plan) carry their
   * grant inline on the gateway session instead and are rewritten the same way.
   */
  private async refreshKeyGrants(row: McpServerRow): Promise<void> {
    const keys = await prisma.apiKey.findMany({
      where: { mcpServerId: row.id, tenantId: row.tenantId },
      select: { id: true, planId: true, tykKeyId: true, tykAclPolicyId: true, name: true },
    });
    if (keys.length === 0) return;

    const tools = readTools(row.tools);
    const tykApiId = row.tykApiId;
    if (!tykApiId) return;

    for (const key of keys) {
      const entry = mcpAclAccessRight(tykApiId, row.name, mcpToolGrants(tools, key.planId));
      try {
        if (key.tykAclPolicyId) {
          const policy = await this.tykClient.getPolicy(key.tykAclPolicyId);
          const rights = { ...(policy.access_rights as Record<string, unknown> | undefined) };
          rights[tykApiId] = entry;
          await this.tykClient.upsertPolicy({ ...policy, access_rights: rights });
        } else if (key.tykKeyId) {
          const session = await this.tykClient.getKey(key.tykKeyId);
          const rights = { ...(session.access_rights ?? {}) };
          rights[tykApiId] = entry;
          await this.tykClient.updateKey(key.tykKeyId, {
            ...session,
            org_id: (await loadTenantScope(row.tenantId)).tykOrgId,
            access_rights: rights,
          });
        }
      } catch (err) {
        // One key failing must not abort the rest: the remaining keys would keep a stale grant with
        // no signal at all. Logged loudly, and a re-save of the server retries every key.
        this.logger.error(
          `MCP server ${row.id}: key ${key.id} ("${key.name}") kept its previous tool grant — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  private asConflict(err: unknown, slug: string, listenPath: string): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined) ?? [];
      return new ConflictException(
        target.includes('listen_path') ? takenBy('listen path', listenPath) : takenBy('slug', slug),
      );
    }
    return err;
  }
}
