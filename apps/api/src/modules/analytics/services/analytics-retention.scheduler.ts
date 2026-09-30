import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { PrismaClient } from '@prisma/client';
import { countJobRun } from '../../../common/metrics/ops-metrics';
import {
  ANALYTICS_INDEX_DDL,
  redactFieldsFrom,
  retentionAggregateQuery,
  retentionRawQuery,
  tablePresenceQuery,
  type TablePresenceRow,
} from './pump-query.builder';
import { ensureRedaction } from './redaction-installer';

const DEFAULT_RAW_RETENTION_DAYS = 30;
const DEFAULT_AGGREGATE_RETENTION_DAYS = 365;

export interface AnalyticsPurgeResult {
  rawDeleted: number;
  aggregateDeleted: number;
}

/**
 * Retention for the pump-owned tables (D10). `tyk_analytics` is unbounded and unindexed by the pump,
 * so it is trimmed aggressively; the small hourly aggregate is kept for a year.
 *
 * `ScheduleModule.forRoot()` is deliberately NOT registered here — `QuotasModule` already registers
 * it and a second root is an error. This provider only declares the cron.
 */
@Injectable()
export class AnalyticsRetentionScheduler {
  private readonly logger = new Logger(AnalyticsRetentionScheduler.name);

  constructor(
    @Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleRetention(): Promise<void> {
    try {
      const { rawDeleted, aggregateDeleted } = await countJobRun('analytics_retention', () =>
        this.purgeExpiredAnalytics(),
      );
      if (rawDeleted > 0 || aggregateDeleted > 0) {
        this.logger.log(
          `Analytics retention: deleted ${String(rawDeleted)} raw and ${String(aggregateDeleted)} aggregate row(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Analytics retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Guarded by `to_regclass`: before the pump's first purge neither table exists. */
  async purgeExpiredAnalytics(): Promise<AnalyticsPurgeResult> {
    const presence = await this.prisma.$queryRaw<TablePresenceRow[]>(tablePresenceQuery());
    const rawPresent = presence[0]?.raw_present ?? false;
    const aggregatePresent = presence[0]?.aggregate_present ?? false;

    let rawDeleted = 0;
    if (rawPresent) {
      // Second chance at the indexes and the redaction trigger: on a cold stack the API boots before
      // the pump creates tyk_analytics, so the init-time DDL finds nothing (D9) — and without the
      // trigger every captured dump would be stored unredacted until the next API boot.
      await this.ensureRawIndexes();
      await this.ensureRedactionTrigger();
      rawDeleted = await this.prisma.$executeRaw(retentionRawQuery(this.rawRetentionDays()));
    }
    const aggregateDeleted = aggregatePresent
      ? await this.prisma.$executeRaw(retentionAggregateQuery(this.aggregateRetentionDays()))
      : 0;

    return { rawDeleted, aggregateDeleted };
  }

  private async ensureRawIndexes(): Promise<void> {
    try {
      await this.prisma.$queryRawUnsafe(ANALYTICS_INDEX_DDL);
    } catch (err) {
      this.logger.warn(
        `Could not ensure analytics indexes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Idempotent; when the trigger was missing it also redacts the dumps stored meanwhile. */
  private async ensureRedactionTrigger(): Promise<void> {
    try {
      const fields = redactFieldsFrom(this.configService.get<string>('ANALYTICS_REDACT_FIELDS'));
      await ensureRedaction(this.prisma, fields, this.rawRetentionDays());
    } catch (err) {
      this.logger.error(
        `Could not ensure analytics redaction trigger: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private rawRetentionDays(): number {
    return this.positiveDays('ANALYTICS_RETENTION_DAYS', DEFAULT_RAW_RETENTION_DAYS);
  }

  private aggregateRetentionDays(): number {
    return this.positiveDays('ANALYTICS_AGGREGATE_RETENTION_DAYS', DEFAULT_AGGREGATE_RETENTION_DAYS);
  }

  private positiveDays(key: string, fallback: number): number {
    const configured = Number(this.configService.get<string>(key));
    return Number.isInteger(configured) && configured > 0 ? configured : fallback;
  }
}
