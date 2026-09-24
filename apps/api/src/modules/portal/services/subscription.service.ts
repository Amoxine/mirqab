import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import { buildKeyAclPolicy, buildTykKeyDef, type KeyApiScope } from '../../keys/services/tyk-key-mapper';
import { ApplicationService } from './application.service';
import type { CreateSubscriptionDto } from '../dto/create-subscription.dto';
import {
  analyticsWindow,
  errorRatePercent,
  keyRollupQuery,
  round2,
  toNumber,
  type RollupRow,
} from '../../analytics/services/pump-query.builder';
import type { KeyUsageDto, KeyUsageRange } from '../../keys/dto/key-usage.dto';

export interface SubscriptionDetail {
  id: string;
  applicationId: string;
  productId: string;
  productName: string;
  planId: string;
  planName: string;
  status: 'PENDING' | 'APPROVED' | 'REVOKED';
  approvedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  /** Only present the one time a key is minted (create/approve) — never stored, never re-shown. */
  keyValue?: string;
}

const withNames = {
  product: { select: { name: true } },
  plan: { select: { name: true } },
} satisfies Prisma.SubscriptionInclude;
type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof withNames }>;

function toDetail(row: SubscriptionRow, keyValue?: string): SubscriptionDetail {
  return {
    id: row.id,
    applicationId: row.applicationId,
    productId: row.productId,
    productName: row.product.name,
    planId: row.planId,
    planName: row.plan.name,
    status: row.status,
    approvedAt: row.approvedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    ...(keyValue !== undefined && { keyValue }),
  };
}

/**
 * An application's grant to one product at one plan tier (WP22) — the thing that mints a Tyk key.
 *
 * Reuses WP18's two-policy pattern exactly: the PLAN's own policy (already on the gateway, built
 * when the plan itself was created — `PlanService`) carries rate/quota, and a per-subscription ACL
 * policy built here (`buildKeyAclPolicy`, extended to accept every API the PRODUCT bundles rather
 * than a single one) carries the actual access grant. `apply_policies: [planId, aclPolicyId]` is
 * what combines them on one key, exactly as `KeyService.create` does for a plan-governed dashboard
 * key — this is the same mechanism, aimed at a product's whole API set instead of one API.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly tykClient: TykClientService,
    private readonly applications: ApplicationService,
  ) {}

  /**
   * Always created PENDING first, then approved (and its key issued) in the same call unless the
   * plan requires manual review — see `Plan.requiresApproval`'s doc comment for why there is no
   * separate admin-approve endpoint yet. PENDING mints no key at all: not a key nobody can use, an
   * absent one.
   */
  async create(dto: CreateSubscriptionDto, applicationId: string, developerId: string, tenantId: string): Promise<SubscriptionDetail> {
    await this.applications.findRow(applicationId, developerId); // 403/404, ownership check only

    const product = await prisma.product.findFirst({ where: { id: dto.productId, tenantId } });
    if (!product) throw new NotFoundException(`Product ${dto.productId} not found`);

    const plan = await prisma.plan.findFirst({ where: { id: dto.planId, tenantId } });
    if (!plan) throw new NotFoundException(`Plan ${dto.planId} not found`);
    if (!plan.active) {
      throw new BadRequestException(`Plan "${plan.name}" is not published`);
    }

    let row: SubscriptionRow;
    try {
      row = await prisma.subscription.create({
        data: { applicationId, productId: dto.productId, planId: dto.planId },
        include: withNames,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('This application is already subscribed to this product.');
      }
      throw err;
    }

    if (!plan.requiresApproval) {
      const { row: approved, keyValue } = await this.approveAndIssueKey(row, tenantId);
      return toDetail(approved, keyValue);
    }

    return toDetail(row);
  }

  async findAllForApplication(applicationId: string, developerId: string): Promise<SubscriptionDetail[]> {
    await this.applications.findRow(applicationId, developerId);
    const rows = await prisma.subscription.findMany({
      where: { applicationId },
      include: withNames,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => toDetail(row));
  }

  /**
   * Tear the key and its ACL policy down, then mark REVOKED. Tyk answers a deleted/unknown
   * AUTH_TOKEN key with 403 "Access Denied" (live-verified — not 401, which is what this WP's
   * acceptance asks for: one consistent status for an inactive key, not "401 or 403").
   */
  async revoke(id: string, developerId: string): Promise<SubscriptionDetail> {
    const row = await this.findOwnedRow(id, developerId);
    if (row.status === 'REVOKED') {
      throw new ConflictException('Subscription is already revoked');
    }

    if (row.tykKeyId) {
      try {
        await this.tykClient.deleteKey(row.tykKeyId);
      } catch (err) {
        this.logger.error(`Failed to revoke gateway key for subscription ${id}: ${String(err)}`);
        throw new BadGatewayException('Could not revoke the key on the gateway; it was not revoked');
      }
    }
    if (row.tykAclPolicyId) {
      await this.tykClient.deletePolicy(row.tykAclPolicyId).catch((err: unknown) => {
        this.logger.error(`Could not delete access policy for subscription ${id}: ${String(err)}`);
      });
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date() },
      include: withNames,
    });
    return toDetail(updated);
  }

  /**
   * Usage for THIS developer's own key, same shape and same pump query as the dashboard's
   * `KeyService.getUsage` — a PENDING/REVOKED subscription (no live key) reads as all zeros/nulls
   * rather than an error, matching that method's own "no traffic degrades to zero" rule.
   */
  async getUsage(id: string, developerId: string, range: KeyUsageRange = '24h'): Promise<KeyUsageDto> {
    const row = await this.findOwnedRow(id, developerId);

    const none: KeyUsageDto = {
      range,
      requests: 0,
      errors: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      quotaMax: null,
      quotaRemaining: null,
      quotaResetAt: null,
    };
    if (!row.tykKeyId) return none;

    const rollup = await this.readRollup(row.tykKeyId, range);
    const tyk = row.status === 'APPROVED' ? await this.readTykQuota(row.tykKeyId) : null;

    return {
      range,
      requests: rollup.requests,
      errors: rollup.errors,
      errorRate: errorRatePercent(rollup.errors, rollup.requests),
      avgLatencyMs: round2(rollup.avgLatencyMs),
      quotaMax: tyk?.quotaMax ?? null,
      quotaRemaining: tyk?.quotaRemaining ?? null,
      quotaResetAt: tyk?.quotaResetAt ?? null,
    };
  }

  private async approveAndIssueKey(row: SubscriptionRow, tenantId: string): Promise<{ row: SubscriptionRow; keyValue: string }> {
    const apis = await this.productApiScopes(row.productId);
    const orgId = (await loadTenantScope(tenantId)).tykOrgId;

    const aclPolicyId = randomUUID();
    const aclPolicy = buildKeyAclPolicy(aclPolicyId, apis, orgId);
    if (!aclPolicy) {
      // No synced API in the product yet — nothing to grant, so no key can authorize anything.
      throw new BadRequestException(
        'This product has no API synced to the gateway yet; try subscribing again in a moment.',
      );
    }

    try {
      await this.tykClient.upsertPolicy(aclPolicy);
    } catch (err) {
      this.logger.error(`Failed to create the access policy for subscription ${row.id}: ${String(err)}`);
      throw new BadGatewayException('Could not authorize the subscription on the gateway');
    }

    const keyDef = buildTykKeyDef({ name: `subscription-${row.id}`, planId: row.planId }, apis, orgId, undefined, aclPolicyId);

    let created: { keyHash: string; key: string };
    try {
      created = await this.tykClient.createKey(keyDef);
    } catch (err) {
      await this.tykClient.deletePolicy(aclPolicyId).catch((cleanupErr: unknown) => {
        this.logger.error(`Orphaned access policy ${aclPolicyId} after a failed key creation: ${String(cleanupErr)}`);
      });
      this.logger.error(`Failed to create gateway key for subscription ${row.id}: ${String(err)}`);
      throw new BadGatewayException('Could not issue the key on the gateway');
    }

    const updated = await prisma.subscription.update({
      where: { id: row.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        tykKeyId: created.keyHash,
        keyHash: createHash('sha256').update(created.key).digest('hex'),
        tykAclPolicyId: aclPolicyId,
      },
      include: withNames,
    });

    return { row: updated, keyValue: created.key };
  }

  /** Every API the product bundles that has actually reached the gateway (a never-synced API grants nothing). */
  private async productApiScopes(productId: string): Promise<KeyApiScope[]> {
    const links = await prisma.productApi.findMany({
      where: { productId },
      select: { apiDef: { select: { name: true, tykApiId: true } } },
    });
    return links.map((link) => link.apiDef);
  }

  /** Ownership resolved through the application, never a bare subscription id — same 403/404 split as ApplicationService. */
  private async findOwnedRow(id: string, developerId: string): Promise<SubscriptionRow> {
    const row = await prisma.subscription.findUnique({ where: { id }, include: withNames });
    if (!row) throw new NotFoundException('Subscription not found');

    const application = await prisma.application.findUnique({ where: { id: row.applicationId } });
    if (application?.developerId !== developerId) {
      throw new ForbiddenException('This subscription belongs to a different account');
    }
    return row;
  }

  private async readRollup(
    keyHash: string,
    range: KeyUsageRange,
  ): Promise<{ requests: number; errors: number; avgLatencyMs: number }> {
    try {
      const rows = await prisma.$queryRaw<RollupRow[]>(keyRollupQuery(analyticsWindow(range), [keyHash]));
      const row = rows.at(0);
      return {
        requests: toNumber(row?.requests),
        errors: toNumber(row?.errors),
        avgLatencyMs: toNumber(row?.avg_latency_ms),
      };
    } catch (err) {
      // Pump has not created its tables yet — same tolerance as KeyService.getUsage.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
        return { requests: 0, errors: 0, avgLatencyMs: 0 };
      }
      throw err;
    }
  }

  private async readTykQuota(
    keyHash: string,
  ): Promise<{ quotaMax: number | null; quotaRemaining: number | null; quotaResetAt: Date | null } | null> {
    try {
      const state = await this.tykClient.getKey(keyHash);
      const quotaMax = state.quota_max ?? 0;
      if (quotaMax <= 0) return null; // no quota on this key
      return {
        quotaMax,
        quotaRemaining: state.quota_remaining ?? quotaMax,
        quotaResetAt: state.quota_renews ? new Date(state.quota_renews * 1000) : null,
      };
    } catch (err) {
      this.logger.warn(`Live gateway state unavailable for subscription key: ${String(err)}`);
      return null;
    }
  }
}
