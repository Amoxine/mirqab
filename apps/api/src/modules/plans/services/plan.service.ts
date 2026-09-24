import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Plan } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { TykClientService, type NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import { McpService } from '../../mcp/services/mcp.service';
import { buildPlanPolicy } from './plan-policy';
import type { CreatePlanDto, UpdatePlanDto } from '../dto/plan.dto';

/** Response shape for every `/plans` route. `keyCount` is how many keys this plan governs. */
export interface PlanDetail {
  id: string;
  name: string;
  description: string | null;
  rate: number;
  per: number;
  quotaMax: number;
  quotaPeriod: Plan['quotaPeriod'];
  active: boolean;
  keyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const withKeyCount = { _count: { select: { apiKeys: true } } } satisfies Prisma.PlanInclude;
type PlanRow = Prisma.PlanGetPayload<{ include: typeof withKeyCount }>;

function toDetail(row: PlanRow): PlanDetail {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rate: row.rate,
    per: row.per,
    quotaMax: row.quotaMax,
    quotaPeriod: row.quotaPeriod,
    active: row.active,
    keyCount: row._count.apiKeys,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const nameTaken = (name: string): string =>
  `A plan named "${name}" already exists in this tenant.`;

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    private readonly tykClient: TykClientService,
    private readonly mcpService: McpService,
  ) {}

  /**
   * The `access_rights` this plan's policy carries (WP28).
   *
   * Empty for a tenant with no MCP server, which is the `{}` WP18 always produced — a plan is still
   * a limit tier, not a grant of APIs, and this policy still has `partitions.acl: false`. What goes
   * in is strictly rate-limit material: the per-primitive limits of the MCP tools this plan grants.
   * They have to live here because `mcp_primitives` is honoured only by the policy that owns the
   * `rate_limit` partition; on a key's ACL policy it is stored and silently ignored (verified both
   * ways against v5.15.0 — see mcp-mapper.ts).
   */
  private async accessRights(tenantId: string, planId: string): Promise<Record<string, unknown>> {
    return this.mcpService.planAccessRights(tenantId, planId);
  }

  /**
   * Create the row, then push its policy to every node.
   *
   * The policy write is awaited, unlike an API definition's background sync: a plan whose policy is
   * not on the gateway is not merely "pending", it makes every key assigned to it fail closed with
   * "Could not find a valid policy to apply to this token". `upsertPolicy` already blocks until the
   * reload lands on each node, so a 201 here means the plan is genuinely usable.
   *
   * If the push fails the row is removed again rather than left behind: a plan the UI lists but the
   * gateway has never heard of is the state that produces unexplainable 403s at key-issue time.
   */
  async create(dto: CreatePlanDto, tenantId: string): Promise<PlanDetail> {
    const { tykOrgId } = await loadTenantScope(tenantId);

    let row: PlanRow;
    try {
      row = await prisma.plan.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          rate: dto.rate ?? 0,
          per: dto.per ?? 1,
          quotaMax: dto.quotaMax ?? -1,
          quotaPeriod: dto.quotaPeriod,
          active: dto.active ?? true,
        },
        include: withKeyCount,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(nameTaken(dto.name));
      }
      throw err;
    }

    try {
      await this.tykClient.upsertPolicy(
        buildPlanPolicy(row, tykOrgId, await this.accessRights(tenantId, row.id)),
      );
    } catch (err) {
      await prisma.plan.delete({ where: { id: row.id } }).catch((cleanupErr: unknown) => {
        // The row now outlives its failed policy push. Say so loudly — it is the one state this
        // method cannot repair on its own.
        this.logger.error(
          `Plan ${row.id} could not be rolled back after its policy push failed: ${String(cleanupErr)}`,
        );
      });
      throw err;
    }

    return toDetail(row);
  }

  async findAll(tenantId: string): Promise<PlanDetail[]> {
    const rows = await prisma.plan.findMany({
      where: { tenantId },
      include: withKeyCount,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDetail);
  }

  async findOne(id: string, tenantId: string): Promise<PlanDetail> {
    return toDetail(await this.findRow(id, tenantId));
  }

  /**
   * Edit a plan and re-push its single policy.
   *
   * This is the feature: Tyk resolves `apply_policies` per request, so rewriting one policy changes
   * the effective limit for every key that references it. No key row is read or written here — if
   * this method ever starts touching keys, the indirection has been lost.
   */
  async update(id: string, dto: UpdatePlanDto, tenantId: string): Promise<PlanDetail> {
    await this.findRow(id, tenantId);
    const { tykOrgId } = await loadTenantScope(tenantId);

    let row: PlanRow;
    try {
      row = await prisma.plan.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          rate: dto.rate,
          per: dto.per,
          quotaMax: dto.quotaMax,
          quotaPeriod: dto.quotaPeriod,
          active: dto.active,
        },
        include: withKeyCount,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(nameTaken(dto.name ?? ''));
      }
      throw err;
    }

    await this.tykClient.upsertPolicy(
      buildPlanPolicy(row, tykOrgId, await this.accessRights(tenantId, row.id)),
    );
    return toDetail(row);
  }

  /**
   * Delete the plan and its policy. Keys assigned to it survive — the FK is `SET NULL`, so they
   * fall back to having no policy rather than being destroyed along with a commercial decision.
   */
  async remove(id: string, tenantId: string): Promise<{ message: string; unassignedKeys: number }> {
    const row = await this.findRow(id, tenantId);
    const unassignedKeys = row._count.apiKeys;

    await this.tykClient.deletePolicy(id);
    await prisma.plan.delete({ where: { id } });

    return {
      message: `Plan "${row.name}" deleted.`,
      unassignedKeys,
    };
  }

  /** Re-push a plan's policy to every node, for the per-node assertion and for drift repair. */
  async syncPolicy(id: string, tenantId: string): Promise<NodeOutcome[]> {
    const row = await this.findRow(id, tenantId);
    const { tykOrgId } = await loadTenantScope(tenantId);
    return this.tykClient.upsertPolicy(
      buildPlanPolicy(row, tykOrgId, await this.accessRights(tenantId, row.id)),
    );
  }

  /** Tenant-scoped lookup. Scoping the WHERE (not filtering after) is what makes this isolated. */
  private async findRow(id: string, tenantId: string): Promise<PlanRow> {
    const row = await prisma.plan.findFirst({ where: { id, tenantId }, include: withKeyCount });
    if (!row) throw new NotFoundException(`Plan ${id} not found`);
    return row;
  }
}
