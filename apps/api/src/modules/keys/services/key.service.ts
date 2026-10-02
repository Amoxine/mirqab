import { createHash, randomUUID } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import {
  ApiDefinition,
  ApiKey,
  ApiKeyStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { CreateKeyDto } from '../dto/create-key.dto';
import { UpdateKeyDto } from '../dto/update-key.dto';
import { KeyListItemDto, KeyDetailResponseDto, KeyTykStateDto } from '../dto/key-response.dto';
import { KeyUsageDto, KeyUsageRange } from '../dto/key-usage.dto';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { QuotaService } from '../../quotas/services/quota.service';
import {
  analyticsWindow,
  errorRatePercent,
  keyRollupQuery,
  round2,
  toNumber,
  type RollupRow,
} from '../../analytics/services/pump-query.builder';
import { buildTykKeyDef, buildKeyAclPolicy, applyKeyUpdate, type KeyApiScope } from './tyk-key-mapper';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import { McpService } from '../../mcp/services/mcp.service';
import { OrgQuotaService } from '../../quotas/services/org-quota.service';

/** Tyk answers a missing key with 404 "Key not found" / "There is no such key found". */
const TYK_KEY_MISSING = /not found|no such key/i;

const MAX_PAGE_SIZE = 100;

/** `$queryRaw` on a pump table that does not exist yet surfaces as P2010 wrapping Postgres 42P01. */
const isMissingTable = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010' && err.meta?.code === '42P01';

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

@Injectable()
export class KeyService {
  private readonly logger = new Logger(KeyService.name);

  constructor(
    private readonly tykClient: TykClientService,
    private readonly quotaService: QuotaService,
    private readonly mcpService: McpService,
    private readonly orgQuota: OrgQuotaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new API key.
   *
   * Flow:
   * 1. If planned, build and push its companion ACL policy first (WP18 fix — see buildKeyAclPolicy)
   * 2. Build Tyk key definition with rate limits / quotas
   * 3. Call Tyk to create the key → get { keyHash, key }
   * 4. Hash the raw key with SHA-256 (NEVER store raw key)
   * 5. Create ApiKey record in DB with keyHash
   * 6. If quota params provided, create Quota record
   * 7. Return response with raw keyValue shown ONCE
   */
  async create(
    dto: CreateKeyDto,
    tenantId: string,
    userId: string,
  ): Promise<{
    id: string;
    name: string;
    status: ApiKeyStatus;
    expiresAt: Date | null;
    createdAt: Date;
    keyValue: string;
    apiDefId: string | null;
    planId: string | null;
  }> {
    // Validate apiDefId if provided
    const apiDef = dto.apiDefId ? await this.validateApiDef(dto.apiDefId, tenantId) : null;
    if (apiDef && !apiDef.tykApiId) {
      throw new BadRequestException('API is not synced to the gateway yet, try again in a moment');
    }

    // WP18: a plan must belong to THIS tenant. Without the check a caller could name another
    // tenant's plan id and have the gateway apply that tenant's commercial limits to its own key.
    if (dto.planId) {
      const plan = await prisma.plan.findFirst({
        where: { id: dto.planId, tenantId },
        select: { id: true },
      });
      if (!plan) throw new BadRequestException(`Plan ${dto.planId} not found in this tenant`);
    }

    const orgId = (await loadTenantScope(tenantId)).tykOrgId;

    // WP28: an MCP proxy is a second, independent scope — its own gateway API with its own
    // credential, not the source REST API's. `mcpTools` is the tool grant this key's PLAN produces
    // (`mcpToolGrants`), which is what makes a key on the wrong plan answer 403 on a bound tool.
    const mcpScope = dto.mcpServerId
      ? await this.mcpService.keyAccessRight(dto.mcpServerId, tenantId, dto.planId ?? null)
      : null;
    if (dto.mcpServerId && !mcpScope) {
      throw new BadRequestException(
        `MCP server ${dto.mcpServerId} not found in this tenant, or not synced to the gateway yet`,
      );
    }
    const scopes: KeyApiScope[] = [
      ...(apiDef ? [apiDef] : []),
      ...(mcpScope ? [mcpScope.scope] : []),
    ];

    // Step 1: a planned key needs a companion ACL policy pushed BEFORE the key references it — see
    // buildKeyAclPolicy's doc comment for why the plan's own policy cannot carry this key's access.
    // Null when there is nothing to grant (no synced apiDef and no MCP server), same as a non-plan
    // apiDef-less key.
    const aclPolicy = dto.planId ? buildKeyAclPolicy(randomUUID(), scopes, orgId) : null;
    if (aclPolicy) {
      try {
        await this.tykClient.upsertPolicy(aclPolicy);
      } catch (err) {
        this.logger.error(
          `Failed to create the access policy for a new key: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new BadRequestException('Failed to create API key');
      }
    }
    const aclPolicyId = aclPolicy ? (aclPolicy.id as string) : undefined;

    // Step 2: Build Tyk key definition
    const tykKeyDef = buildTykKeyDef(dto, scopes, orgId, undefined, aclPolicyId);

    // Step 3: Create key in Tyk
    let tykResult: { keyHash: string; key: string };
    try {
      tykResult = await this.tykClient.createKey(tykKeyDef);
    } catch (err) {
      if (aclPolicyId) {
        await this.tykClient.deletePolicy(aclPolicyId).catch((cleanupErr: unknown) => {
          this.logger.error(
            `Orphaned access policy ${aclPolicyId} after a failed key creation; delete it manually: ` +
              (cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)),
          );
        });
      }
      this.logger.error(
        `Failed to create key in Tyk: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Failed to create API key');
    }

    // Step 4: Hash the raw key value
    const keyHash = this.hashKey(tykResult.key);

    // Step 5: Create ApiKey record in DB
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    let apiKey: ApiKey;
    try {
      apiKey = await prisma.apiKey.create({
        data: {
          tenantId,
          userId,
          name: dto.name,
          tykKeyId: tykResult.keyHash,
          keyHash,
          status: ApiKeyStatus.ACTIVE,
          expiresAt,
          apiDefId: dto.apiDefId ?? null,
          mcpServerId: dto.mcpServerId ?? null,
          planId: dto.planId ?? null,
          tykAclPolicyId: aclPolicyId ?? null,
        },
      });
    } catch (err) {
      // The gateway key already exists but nothing references it: it would authenticate traffic that
      // no one can see or revoke. Best effort compensation — the hash is logged if even that fails,
      // since it is the only handle left to remove it by hand (it is not a usable credential).
      try {
        await this.tykClient.deleteKey(tykResult.keyHash);
        if (aclPolicyId) await this.tykClient.deletePolicy(aclPolicyId);
      } catch (cleanupErr) {
        this.logger.error(
          `Orphaned gateway key ${tykResult.keyHash}` +
            (aclPolicyId ? ` (and access policy ${aclPolicyId})` : '') +
            ` after a failed database write; delete it manually: ` +
            (cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)),
        );
      }
      throw err;
    }

    // Step 6: Create quota record if quota params provided
    if (dto.quotaLimit && dto.quotaPeriod) {
      await this.quotaService.create(apiKey.id, dto.quotaLimit, dto.quotaPeriod);
    }

    // Step 7: Return with raw keyValue (shown ONCE)
    return {
      id: apiKey.id,
      name: apiKey.name,
      status: apiKey.status,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      keyValue: tykResult.key,
      apiDefId: apiKey.apiDefId,
      planId: apiKey.planId,
    };
  }

  /**
   * Find all keys for a tenant with pagination and optional status / API filters.
   * Always tenant-scoped, so an `apiDefId` of another tenant yields an empty page.
   * NEVER returns keyHash or tykKeyId.
   */
  async findAll(
    tenantId: string,
    page = 1,
    pageSize = 20,
    status?: ApiKeyStatus,
    apiDefId?: string,
  ): Promise<PaginatedResult<KeyListItemDto>> {
    // Clamped like ApiService: page=0 produced a negative skip (Prisma 500) and pageSize was unbounded.
    const safePage = Math.max(1, page);
    const take = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const where: Prisma.ApiKeyWhereInput = { tenantId };

    if (status) {
      where.status = status;
    }

    if (apiDefId) {
      where.apiDefId = apiDefId;
    }

    const [rows, totalCount] = await Promise.all([
      prisma.apiKey.findMany({
        where,
        skip: (safePage - 1) * take,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          status: true,
          expiresAt: true,
          createdAt: true,
          apiDefId: true,
          apiDef: { select: { name: true } },
          planId: true,
          plan: { select: { name: true } },
        },
      }),
      prisma.apiKey.count({ where }),
    ]);

    return {
      data: rows.map(({ apiDef, plan, ...key }) => ({
        ...key,
        apiDefName: apiDef?.name ?? null,
        planName: plan?.name ?? null,
      })),
      meta: {
        page: safePage,
        pageSize: take,
        totalCount,
        totalPages: Math.ceil(totalCount / take),
      },
    };
  }

  /**
   * Find a single key by ID, verifying tenant ownership, with its live gateway limits (D3).
   * `tyk` is null when the gateway cannot be reached or the key is no longer active — never an error.
   * NEVER returns keyHash or tykKeyId.
   */
  async findOne(id: string, tenantId: string): Promise<KeyDetailResponseDto> {
    const apiKey = await prisma.apiKey.findUnique({
      where: { id },
      include: {
        apiDef: { select: { name: true } },
        plan: { select: { name: true } },
      },
    });

    if (apiKey?.tenantId !== tenantId) {
      throw new NotFoundException('API key not found');
    }

    return {
      id: apiKey.id,
      name: apiKey.name,
      status: apiKey.status,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      apiDefId: apiKey.apiDefId,
      apiDefName: apiKey.apiDef?.name ?? null,
      planId: apiKey.planId,
      planName: apiKey.plan?.name ?? null,
      tyk: apiKey.status === ApiKeyStatus.ACTIVE ? await this.readTykState(apiKey) : null,
    };
  }

  /**
   * Update a key: local name / expiry, then the Tyk key (rate, quota, expiry, alias).
   * Tyk replaces the whole key on PUT, so the live state is read first and resent with the changes.
   * Changing the quota resets its consumption (Tyk behaviour).
   */
  async update(id: string, dto: UpdateKeyDto, tenantId: string): Promise<KeyDetailResponseDto> {
    const apiKey = await prisma.apiKey.findUnique({
      where: { id },
      include: { apiDef: { select: { name: true, tykApiId: true } } },
    });

    if (apiKey?.tenantId !== tenantId) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.status !== ApiKeyStatus.ACTIVE) {
      throw new ConflictException(`API key is ${apiKey.status.toLowerCase()} and can no longer be updated`);
    }

    const tykKeyId = apiKey.tykKeyId;
    if (!tykKeyId) {
      throw new ConflictException('API key is not linked to a gateway key');
    }

    const current = await this.viaGateway('read', id, () => this.tykClient.getKey(tykKeyId));
    const tykKeyDef = applyKeyUpdate(current, dto, apiKey.apiDef, (await loadTenantScope(tenantId)).tykOrgId);
    await this.viaGateway('update', id, () => this.tykClient.updateKey(tykKeyId, tykKeyDef));

    const data: Prisma.ApiKeyUpdateInput = { name: dto.name };
    if (dto.expiresAt !== undefined) {
      data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }
    await prisma.apiKey.update({ where: { id }, data });

    // Keep the local quota row in step (vestigial: the gateway is the enforcing authority)
    if (dto.quotaLimit === 0) {
      await prisma.quota.deleteMany({ where: { apiKeyId: id } });
    } else if (dto.quotaLimit !== undefined || dto.quotaPeriod !== undefined) {
      await this.quotaService.upsert(id, dto.quotaLimit, dto.quotaPeriod);
    }

    return this.findOne(id, tenantId);
  }

  /**
   * Revoke an API key.
   * 1. Find key, verify tenant ownership
   * 2. Delete from Tyk by key hash (a key Tyk no longer knows is fine)
   * 3. Update status to REVOKED
   * 4. Audit log created automatically by interceptor
   */
  async revoke(id: string, tenantId: string): Promise<ApiKey> {
    const apiKey = await prisma.apiKey.findUnique({
      where: { id },
    });

    if (apiKey?.tenantId !== tenantId) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.status === ApiKeyStatus.REVOKED) {
      throw new ConflictException('API key is already revoked');
    }

    // A key Tyk no longer knows is fine; any other gateway failure means the key may still be live,
    // so it must NOT be marked revoked.
    if (apiKey.tykKeyId) {
      try {
        await this.deleteTykKey(apiKey);
      } catch {
        throw new BadGatewayException('Could not revoke the key on the gateway; it was not revoked');
      }
    }

    // Update status locally
    const revoked = await prisma.apiKey.update({
      where: { id },
      data: { status: ApiKeyStatus.REVOKED },
    });

    this.logger.log(`API key ${id} revoked for tenant ${tenantId}`);

    return revoked;
  }

  /**
   * Mint a brand new gateway key with the SAME live settings (rate/quota/access_rights/policies) and
   * point this row at it, then drop the old one (WP19, U11).
   *
   * `applyKeyUpdate(current, {}, null, orgId)` is reused rather than reconstructed: an empty patch
   * makes it exactly "the live session, unchanged, with org_id re-set" — the same normalisation PUT
   * already relies on to resend `current` safely — which is precisely what a fresh `POST /keys/create`
   * needs (see that function's doc comment for why the raw `getKey` response is not safe to resend
   * as-is). The old key is deleted only AFTER the new one is confirmed minted and the row updated, so
   * a failure anywhere in between never leaves the tenant with neither.
   */
  async rotate(id: string, tenantId: string): Promise<{ id: string; keyValue: string }> {
    const apiKey = await prisma.apiKey.findUnique({ where: { id } });
    if (apiKey?.tenantId !== tenantId) {
      throw new NotFoundException('API key not found');
    }
    if (apiKey.status !== ApiKeyStatus.ACTIVE) {
      throw new ConflictException(`API key is ${apiKey.status.toLowerCase()} and can no longer be rotated`);
    }
    const tykKeyId = apiKey.tykKeyId;
    if (!tykKeyId) {
      throw new ConflictException('API key is not linked to a gateway key');
    }

    const { tykOrgId } = await loadTenantScope(tenantId);
    const current = await this.viaGateway('read', id, () => this.tykClient.getKey(tykKeyId));
    const newKeyDef = applyKeyUpdate(current, {}, null, tykOrgId);
    const tykResult = await this.viaGateway('rotate', id, () => this.tykClient.createKey(newKeyDef));
    const keyHash = this.hashKey(tykResult.key);

    await prisma.apiKey.update({ where: { id }, data: { tykKeyId: tykResult.keyHash, keyHash } });

    await this.tykClient.deleteKey(tykKeyId).catch((err: unknown) => {
      this.logger.error(
        `Old gateway key ${tykKeyId} for rotated key ${id} could not be deleted; delete it manually: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });

    return { id: apiKey.id, keyValue: tykResult.key };
  }

  /** Zero this key's usage counter, on both sides — thin delegate to WP18's OrgQuotaService, which
   * already resets the local `Quota.used` row and the gateway's live counter together. */
  async resetUsage(id: string, tenantId: string): Promise<{ apiKeyId: string; gatewayReset: boolean }> {
    return this.orgQuota.resetKey(id, tenantId);
  }

  /**
   * Hard-delete a key row. Refused while the key is still ACTIVE — revoke it first, so a delete can
   * never remove a credential the gateway still honours. `Quota` cascades on the FK; nothing else
   * references `ApiKey` by foreign key (AuditLog stores an id string, not a relation).
   */
  async remove(id: string, tenantId: string): Promise<void> {
    const apiKey = await prisma.apiKey.findUnique({ where: { id } });
    if (apiKey?.tenantId !== tenantId) {
      throw new NotFoundException('API key not found');
    }
    if (apiKey.status === ApiKeyStatus.ACTIVE) {
      throw new ConflictException('Revoke this key before deleting it');
    }
    await prisma.apiKey.delete({ where: { id } });
  }

  /**
   * List all keys scoped to a specific API definition.
   */
  async findByApiDef(
    apiDefId: string,
    tenantId: string,
  ): Promise<Omit<ApiKey, 'keyHash' | 'tykKeyId'>[]> {
    return prisma.apiKey.findMany({
      where: { apiDefId, tenantId },
      orderBy: { createdAt: 'desc' },
      select: this.listSelectFields(),
    });
  }

  /**
   * Scheduled job: find all expired keys, update status to EXPIRED, revoke in Tyk.
   */
  async checkExpired(): Promise<number> {
    const now = new Date();

    const expiredKeys = await prisma.apiKey.findMany({
      where: {
        status: ApiKeyStatus.ACTIVE,
        expiresAt: { not: null, lte: now },
      },
    });

    if (expiredKeys.length === 0) {
      return 0;
    }

    let revokedCount = 0;

    for (const key of expiredKeys) {
      try {
        // Revoke in Tyk. A key the gateway has already dropped must not keep this row ACTIVE and be
        // retried every night, so "key not found" is tolerated here exactly as in revoke().
        if (key.tykKeyId) {
          await this.deleteTykKey(key);
        }

        // Update local status
        await prisma.apiKey.update({
          where: { id: key.id },
          data: { status: ApiKeyStatus.EXPIRED },
        });

        revokedCount++;
        this.logger.log(`Expired key ${key.id} (${key.name}) marked as EXPIRED`);
      } catch (err) {
        this.logger.error(
          `Failed to expire key ${key.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return revokedCount;
  }

  /**
   * Usage of a key over `range`: request / error / latency rollup from the pump tables (keyed by the
   * key's Tyk hash) merged with the live quota from Tyk. It reads through the same window rule and
   * query builder as `/analytics/keys`, so the two endpoints report the same numbers for the same key.
   * No traffic, no pump table, or an unreachable gateway degrade to zeros / nulls, never an error.
   */
  async getUsage(keyId: string, tenantId: string, range: KeyUsageRange = '24h'): Promise<KeyUsageDto> {
    const apiKey = await prisma.apiKey.findUnique({ where: { id: keyId } });

    if (apiKey?.tenantId !== tenantId) {
      throw new NotFoundException('API key not found');
    }

    const [rollup, tyk] = await Promise.all([
      this.readRollup(apiKey.tykKeyId, range),
      apiKey.status === ApiKeyStatus.ACTIVE ? this.readTykState(apiKey) : null,
    ]);

    // quota_max <= 0 means the key has no quota
    const quota = tyk && tyk.quotaMax > 0 ? tyk : null;

    return {
      range,
      requests: rollup.requests,
      errors: rollup.errors,
      errorRate: errorRatePercent(rollup.errors, rollup.requests),
      avgLatencyMs: round2(rollup.avgLatencyMs),
      quotaMax: quota?.quotaMax ?? null,
      quotaRemaining: quota?.quotaRemaining ?? null,
      quotaResetAt: quota?.quotaRenewsAt ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Delete a key on the gateway, tolerating "key not found" — it is already gone (or the row predates
   * D5 and holds a raw key), which is the state the caller wanted. TykClientService raises
   * BadRequestException for anything the gateway rejected; those are rethrown, because the key may
   * still be live and the local status must not claim otherwise — and in that case its ACL policy
   * (below) is deliberately left alone too, since the key may still be referencing it.
   *
   * The companion ACL policy (WP18 fix — see `buildKeyAclPolicy`) is this key's alone, so it is
   * cleaned up here rather than left for the plan to eventually collect: only reached once the Tyk
   * key itself is confirmed gone, and a failure to delete it is logged, not thrown — the key is
   * already revoked at that point, and an orphaned policy nothing references grants no live access.
   */
  private async deleteTykKey(apiKey: Pick<ApiKey, 'id' | 'tykKeyId' | 'tykAclPolicyId'>): Promise<void> {
    const tykKeyId = apiKey.tykKeyId;
    if (!tykKeyId) return;

    try {
      await this.tykClient.deleteKey(tykKeyId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof BadRequestException && TYK_KEY_MISSING.test(message))) {
        this.logger.error(`Failed to delete key ${apiKey.id} on the gateway: ${message}`);
        throw err;
      }
      this.logger.warn(`Key ${apiKey.id} is not known to Tyk (${message}); continuing locally`);
    }

    const aclPolicyId = apiKey.tykAclPolicyId;
    if (aclPolicyId) {
      await this.tykClient.deletePolicy(aclPolicyId).catch((err: unknown) => {
        this.logger.error(
          `Could not delete access policy ${aclPolicyId} for key ${apiKey.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
    }
  }

  /**
   * Hash a raw key value using SHA-256.
   */
  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  /**
   * Live rate / quota of a key as enforced by the gateway; null when it cannot be read.
   */
  private async readTykState(apiKey: Pick<ApiKey, 'id' | 'tykKeyId'>): Promise<KeyTykStateDto | null> {
    if (!apiKey.tykKeyId) return null;

    try {
      const state = await this.tykClient.getKey(apiKey.tykKeyId);
      const quotaMax = state.quota_max ?? 0;
      return {
        rate: state.rate ?? 0,
        per: state.per ?? 0,
        quotaMax,
        // Tyk only starts reporting quota_remaining once the key has served a request. Absent means
        // "nothing consumed yet" = the full quota; defaulting to 0 showed a brand-new key as
        // fully exhausted (a full red quota bar next to "Requests 0").
        quotaRemaining: state.quota_remaining ?? quotaMax,
        quotaRenewalRate: state.quota_renewal_rate ?? 0,
        quotaRenewsAt: state.quota_renews ? new Date(state.quota_renews * 1000) : null,
      };
    } catch (err) {
      this.logger.warn(
        `Live gateway state unavailable for key ${apiKey.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Per-key rollup over the shared analytics window (`1h` = raw table over the exact window, longer
   * ranges = hourly aggregate floored to the hour). `keyHash` comes from the tenant-verified ApiKey
   * row, so no extra tenant filter is needed.
   */
  private async readRollup(
    keyHash: string | null,
    range: KeyUsageRange,
  ): Promise<{ requests: number; errors: number; avgLatencyMs: number }> {
    const none = { requests: 0, errors: 0, avgLatencyMs: 0 };
    if (!keyHash) return none;

    try {
      const rows = await prisma.$queryRaw<RollupRow[]>(keyRollupQuery(analyticsWindow(range), [keyHash]));
      const row = rows.at(0);

      return {
        requests: toNumber(row?.requests),
        errors: toNumber(row?.errors),
        avgLatencyMs: toNumber(row?.avg_latency_ms),
      };
    } catch (err) {
      if (isMissingTable(err)) return none; // pump has not created its tables yet
      throw err;
    }
  }

  /**
   * Run a Tyk call for a key edit; any failure becomes a 502 so the caller never sees gateway internals.
   */
  private async viaGateway<T>(action: string, keyId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.logger.error(
        `Failed to ${action} key ${keyId} in Tyk: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException(`Could not ${action} the key on the gateway`);
    }
  }

  /**
   * Validate that an API definition exists and belongs to the tenant.
   */
  private async validateApiDef(apiDefId: string, tenantId: string): Promise<ApiDefinition> {
    const apiDef = await prisma.apiDefinition.findUnique({
      where: { id: apiDefId },
    });

    if (apiDef?.tenantId !== tenantId) {
      throw new NotFoundException(
        `API definition with id "${apiDefId}" not found`,
      );
    }

    return apiDef;
  }

  /**
   * Select fields for list responses — NEVER include keyHash or tykKeyId.
   */
  private listSelectFields(): Prisma.ApiKeySelect {
    return {
      id: true,
      name: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      apiDefId: true,
      userId: true,
      tenantId: true,
    };
  }
}
