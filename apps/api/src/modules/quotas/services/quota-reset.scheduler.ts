import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { countJobRun } from '../../../common/metrics/ops-metrics';
import { QuotaService } from './quota.service';
import { KeyService } from '../../keys/services/key.service';

/**
 * Scheduled tasks for quota management.
 *
 * Runs on the following schedule:
 * - Every hour: Reset expired quotas (past resetAt)
 * - Every day at midnight: Check for expired API keys and mark them EXPIRED
 */
@Injectable()
export class QuotaResetScheduler {
  private readonly logger = new Logger(QuotaResetScheduler.name);

  constructor(
    private readonly quotaService: QuotaService,
    private readonly keyService: KeyService,
  ) {}

  /**
   * Every hour: find quotas past their resetAt, reset used→0, set new resetAt.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleResetExpiredQuotas(): Promise<void> {
    this.logger.debug('Running scheduled task: reset expired quotas');

    try {
      const resetCount = await countJobRun('quota_reset', () => this.quotaService.resetExpiredQuotas());
      if (resetCount > 0) {
        this.logger.log(`Reset ${String(resetCount)} expired quota(s)`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to reset expired quotas: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Every day at midnight: find expired API keys, update status to EXPIRED, revoke in Tyk.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleExpireKeys(): Promise<void> {
    this.logger.debug('Running scheduled task: check for expired API keys');

    try {
      const expiredCount = await countJobRun('key_expiry', () => this.keyService.checkExpired());
      if (expiredCount > 0) {
        this.logger.log(`Marked ${String(expiredCount)} expired API key(s) as EXPIRED`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to check expired keys: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
