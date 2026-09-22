import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { Quota, QuotaPeriod, Prisma } from '@prisma/client';

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new quota record for an API key.
   * Calculates the initial resetAt based on the period.
   */
  async create(
    apiKeyId: string,
    limit: number,
    period: QuotaPeriod,
  ): Promise<Quota> {
    const resetAt = this.calculateResetAt(new Date(), period);

    return prisma.quota.create({
      data: {
        apiKeyId,
        limit,
        used: 0,
        period,
        resetAt,
      },
    });
  }

  /**
   * Reset a quota: set used to 0 and calculate a new resetAt.
   */
  async reset(quotaId: string): Promise<Quota> {
    const quota = await prisma.quota.findUnique({
      where: { id: quotaId },
    });

    if (!quota) {
      throw new Error(`Quota with id ${quotaId} not found`);
    }

    const newResetAt = this.calculateResetAt(new Date(), quota.period);

    return prisma.quota.update({
      where: { id: quotaId },
      data: {
        used: 0,
        resetAt: newResetAt,
      },
    });
  }

  /**
   * Find all quotas past their resetAt that need to be reset.
   */
  async getExpiredQuotas(): Promise<Quota[]> {
    const now = new Date();
    return prisma.quota.findMany({
      where: {
        resetAt: { lte: now },
      },
    });
  }

  /**
   * Reset all quotas that have passed their resetAt.
   * Called by the scheduler every hour.
   */
  async resetExpiredQuotas(): Promise<number> {
    const expiredQuotas = await this.getExpiredQuotas();

    if (expiredQuotas.length === 0) {
      return 0;
    }

    let resetCount = 0;

    for (const quota of expiredQuotas) {
      try {
        await this.reset(quota.id);
        resetCount++;
        this.logger.log(
          `Quota ${quota.id} reset (was ${String(quota.used)}/${String(quota.limit)})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to reset quota ${quota.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return resetCount;
  }

  /**
   * Update a quota's limit and/or period.
   */
  async update(
    quotaId: string,
    updates: { limit?: number; period?: QuotaPeriod },
  ): Promise<Quota> {
    const existing = await prisma.quota.findUnique({
      where: { id: quotaId },
    });

    if (!existing) {
      throw new Error(`Quota with id ${quotaId} not found`);
    }

    const updateData: Prisma.QuotaUpdateInput = {};

    if (updates.limit !== undefined) {
      updateData.limit = updates.limit;
    }

    if (updates.period !== undefined) {
      updateData.period = updates.period;
      // Recalculate resetAt when period changes
      updateData.resetAt = this.calculateResetAt(new Date(), updates.period);
    }

    return prisma.quota.update({
      where: { id: quotaId },
      data: updateData,
    });
  }

  /**
   * Keep the key's local quota row in step with an edit: update the active row in place, or create
   * one. Creating needs both `limit` and `period`; a partial edit of a key without a row is a no-op.
   */
  async upsert(apiKeyId: string, limit?: number, period?: QuotaPeriod): Promise<void> {
    const active = await this.getActiveQuota(apiKeyId);

    if (active) {
      await this.update(active.id, { limit, period });
    } else if (limit !== undefined && period) {
      await this.create(apiKeyId, limit, period);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the active (most recent) quota for an API key.
   */
  private async getActiveQuota(apiKeyId: string): Promise<Quota | null> {
    return prisma.quota.findFirst({
      where: { apiKeyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Calculate the next resetAt timestamp based on the period.
   */
  private calculateResetAt(from: Date, period: QuotaPeriod): Date {
    const resetAt = new Date(from);

    switch (period) {
      case QuotaPeriod.HOURLY:
        resetAt.setHours(resetAt.getHours() + 1);
        resetAt.setMinutes(0, 0, 0);
        break;
      case QuotaPeriod.DAILY:
        resetAt.setDate(resetAt.getDate() + 1);
        resetAt.setHours(0, 0, 0, 0);
        break;
      case QuotaPeriod.WEEKLY:
        resetAt.setDate(resetAt.getDate() + 7);
        resetAt.setHours(0, 0, 0, 0);
        break;
      case QuotaPeriod.MONTHLY:
        // setDate(1) must happen BEFORE setMonth(+1): rolling from day 29-31 straight into next
        // month first can overflow past a short month (Jan 31 + 1 month = Mar 3, skipping Feb
        // entirely). Pinning the day to 1 first means the +1 month step never has 29-31 to overflow.
        resetAt.setDate(1);
        resetAt.setMonth(resetAt.getMonth() + 1);
        resetAt.setHours(0, 0, 0, 0);
        break;
    }

    return resetAt;
  }
}
