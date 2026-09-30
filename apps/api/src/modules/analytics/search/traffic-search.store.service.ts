import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { PrismaClient } from '@prisma/client';
import {
  TRAFFIC_SEARCH_DDL,
  addDays,
  dropPartitionDdl,
  expiredPartitions,
  partitionDdl,
  utcDay,
} from './traffic-search.ddl';

const DEFAULT_RETENTION_DAYS = 30;
/** Partitions created ahead of today, so an insert across midnight never lacks one. */
const DAYS_AHEAD = 2;

/**
 * Owns the search table's lifecycle: creates it, keeps one partition per day ahead of the clock, and
 * drops partitions past `ANALYTICS_RETENTION_DAYS` (the same knob as the raw pump table). Dropping a
 * whole day's partition is a metadata operation, so retention costs no row deletes and no bloat.
 *
 * Its own cron rather than a line in `AnalyticsRetentionScheduler`: that class's constructor is pinned
 * by its specs, and the two jobs do not share state.
 */
@Injectable()
export class TrafficSearchStoreService implements OnModuleInit {
  private readonly logger = new Logger(TrafficSearchStoreService.name);

  constructor(
    @Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.maintain();
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledMaintenance(): Promise<void> {
    await this.maintain();
  }

  /** Never throws: a failure here must not stop the API from booting or the cron from running again. */
  async maintain(now: Date = new Date()): Promise<void> {
    try {
      await this.prisma.$queryRawUnsafe(TRAFFIC_SEARCH_DDL);
      const today = utcDay(now);
      await this.ensurePartitions(Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => addDays(today, i)));
      const dropped = await this.dropExpired(now);
      if (dropped > 0) this.logger.log(`Traffic search: dropped ${String(dropped)} expired partition(s)`);
    } catch (err) {
      this.logger.warn(`Could not maintain the traffic search table: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Creates the partition of each given day if it is missing. */
  async ensurePartitions(days: Date[]): Promise<void> {
    for (const day of days) await this.prisma.$executeRawUnsafe(partitionDdl(day));
  }

  /** Drops partitions older than the retention window; returns how many. */
  async dropExpired(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = to_regclass('public.og_traffic_search')`;
    const expired = expiredPartitions(rows.map((r) => r.name), this.retentionDays(), now);
    for (const name of expired) await this.prisma.$executeRawUnsafe(dropPartitionDdl(name));
    return expired.length;
  }

  private retentionDays(): number {
    const configured = Number(this.configService.get<string>('ANALYTICS_RETENTION_DAYS'));
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
  }
}
