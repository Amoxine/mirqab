import { Injectable, NotFoundException } from '@nestjs/common';
import { QuotaPeriod } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { TykClientService, type NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';

const PERIOD_SECONDS: Record<QuotaPeriod, number> = {
  [QuotaPeriod.HOURLY]: 3600,
  [QuotaPeriod.DAILY]: 86_400,
  [QuotaPeriod.WEEKLY]: 604_800,
  [QuotaPeriod.MONTHLY]: 2_592_000,
};

export interface OrgQuotaState {
  tykOrgId: string;
  quotaMax: number | null;
  quotaRemaining: number | null;
  isInactive: boolean;
}

/**
 * The per-tenant ceiling above every key (WP18).
 *
 * A key's own quota limits that key; the ORG quota limits the tenant as a whole, and it is what
 * makes "tenant A is over its allowance" a single switch rather than a sweep over every key A owns.
 * Tyk evaluates it against the API DEFINITION's `org_id` (verified on 5.15.0), which is why
 * `Tenant.tykOrgId` is stamped on definitions and not only on keys — see `loadTenantScope`.
 *
 * Requires `enforce_org_quotas` and `enforce_org_data_age` on the gateway. With either missing the
 * write still answers 200 and enforces nothing, which is the silent failure WP12c documented.
 */
@Injectable()
export class OrgQuotaService {
  constructor(private readonly tykClient: TykClientService) {}

  async get(tenantId: string): Promise<OrgQuotaState> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    const session = await this.tykClient.getOrgSession(tykOrgId);

    if (!session) {
      return { tykOrgId, quotaMax: null, quotaRemaining: null, isInactive: false };
    }
    return {
      tykOrgId,
      quotaMax: typeof session.quota_max === 'number' ? session.quota_max : null,
      quotaRemaining: typeof session.quota_remaining === 'number' ? session.quota_remaining : null,
      isInactive: session.is_inactive === true,
    };
  }

  /**
   * Set (or clear) the tenant's ceiling. `quotaMax: -1` is Tyk's "unlimited", not zero — zero would
   * refuse every request the tenant makes, which is `isInactive` territory and a different decision.
   */
  async set(
    tenantId: string,
    opts: { quotaMax: number; period?: QuotaPeriod; isInactive?: boolean },
  ): Promise<{ tykOrgId: string; nodes: NodeOutcome[] }> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    const period = PERIOD_SECONDS[opts.period ?? QuotaPeriod.MONTHLY];

    const nodes = await this.tykClient.setOrgSession(tykOrgId, {
      quota_max: opts.quotaMax,
      quota_renewal_rate: opts.quotaMax < 0 ? 0 : period,
      is_inactive: opts.isInactive ?? false,
    });
    return { tykOrgId, nodes };
  }

  /**
   * Zero the tenant's accumulated usage.
   *
   * Deleting the session is how Tyk clears an org counter — there is no "set used to 0" call, and
   * re-POSTing the same session preserves `quota_remaining`. The ceiling is then re-applied, so the
   * net effect is "same limit, counter back to full" rather than "no limit any more".
   */
  async reset(tenantId: string): Promise<{ tykOrgId: string; restored: boolean }> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    const existing = await this.tykClient.getOrgSession(tykOrgId);

    await this.tykClient.deleteOrgSession(tykOrgId);

    if (!existing) return { tykOrgId, restored: false };

    await this.tykClient.setOrgSession(tykOrgId, {
      quota_max: existing.quota_max,
      quota_renewal_rate: existing.quota_renewal_rate,
      is_inactive: existing.is_inactive ?? false,
    });
    return { tykOrgId, restored: true };
  }

  /**
   * Zero one key's counter, on both sides: our `Quota.used` (what the UI reports) and the quota the
   * gateway is actually enforcing. Resetting only our side would show a customer at zero while the
   * gateway kept refusing them, which is the confusing half-state this avoids.
   */
  async resetKey(apiKeyId: string, tenantId: string): Promise<{ apiKeyId: string; gatewayReset: boolean }> {
    const key = await prisma.apiKey.findFirst({
      where: { id: apiKeyId, tenantId },
      select: { id: true, tykKeyId: true },
    });
    if (!key) throw new NotFoundException(`API key ${apiKeyId} not found`);

    await prisma.quota.updateMany({ where: { apiKeyId: key.id }, data: { used: 0 } });

    if (!key.tykKeyId) return { apiKeyId: key.id, gatewayReset: false };

    await this.tykClient.resetKeyQuota(key.tykKeyId);
    return { apiKeyId: key.id, gatewayReset: true };
  }
}
