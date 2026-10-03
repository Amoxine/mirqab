import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, PrismaClient } from '@prisma/client';
import { recordJobRun, searchMaintenanceFailuresTotal, type SearchMaintenancePhase } from '../../../common/metrics/ops-metrics';
import {
  TRAFFIC_SEARCH_DDL,
  addDays,
  dropPartitionDdl,
  expiredPartitions,
  partitionDdl,
  partitionName,
  utcDay,
} from './traffic-search.ddl';
import { isLockTimeout, sqlState } from './traffic-search.query';

const DEFAULT_RETENTION_DAYS = 30;
/** Ten years. `addDays` of a bigger number is an invalid Date, and every comparison with one is false (every row would read as expired). */
const MAX_RETENTION_DAYS = 3650;
/** Partitions created ahead of today, so an insert across midnight never lacks one. */
const DAYS_AHEAD = 2;
/** Held for the length of a DDL transaction, so two API processes (or a boot and a cron) never run the same `CREATE` at once. */
const DDL_LOCK_KEY = 7_243_001;
/** A partition drop needs a lock on the parent too: wait for it this long, per try, rather than queue every search and insert behind it. */
const DROP_LOCK_TIMEOUT = '3s';
const DROP_ATTEMPTS = 3;
const DROP_RETRY_MS = 1000;
const CATALOG_RACE_RETRY_MS = 250;

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

  /**
   * Never throws: a failure here must not stop the API from booting or the cron from running again. Each phase
   * (the table, each day's partition, each drop) fails on its own, is logged by name and counted, and does not stop
   * the ones after it: a partition that cannot be created today must not keep yesterday's from being dropped.
   * Returns whether every step worked.
   */
  async maintain(now: Date = new Date()): Promise<boolean> {
    let ok = await this.step('create', 'the table', () => this.createTable());
    const today = utcDay(now);
    for (let i = 0; i <= DAYS_AHEAD; i += 1) {
      const day = addDays(today, i);
      ok = (await this.step('partition_create', partitionName(day), () => this.ensurePartitions([day]))) && ok;
    }
    try {
      const dropped = await this.dropExpired(now);
      if (dropped > 0) this.logger.log(`Traffic search: dropped ${String(dropped)} expired partition(s)`);
    } catch (err) {
      ok = false;
      this.fail('partition_drop', 'the list of partitions', err);
    }
    recordJobRun('search_maintenance', ok);
    return ok;
  }

  private async step(phase: SearchMaintenancePhase, what: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (err) {
      this.fail(phase, what, err);
      return false;
    }
  }

  private fail(phase: SearchMaintenancePhase, what: string, err: unknown): void {
    searchMaintenanceFailuresTotal.inc({ phase });
    this.logger.warn(`Traffic search maintenance (${phase}): ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** The table, its indexes and its state table: idempotent, and serialised across processes. */
  async createTable(): Promise<void> {
    await this.inDdlTransaction(async (tx) => {
      await tx.$queryRawUnsafe(TRAFFIC_SEARCH_DDL);
    });
  }

  /** Creates the partition of each given day if it is missing. */
  async ensurePartitions(days: Date[]): Promise<void> {
    for (const day of days) {
      await this.inDdlTransaction(async (tx) => {
        await tx.$executeRawUnsafe(partitionDdl(day));
      });
    }
  }

  /**
   * One DDL statement under an advisory lock. `CREATE TABLE IF NOT EXISTS` is not safe against another session doing
   * the same one at the same moment (it fails with 42P07 or 23505 on a catalog entry: seen in 1 of 3 concurrent
   * rounds), so the lock serialises them, and a failure of that kind is retried once in case the other process was
   * not one of ours.
   */
  private async inDdlTransaction(run: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DDL_LOCK_KEY}::bigint)`; // not $queryRaw: its void column cannot be read back
            await run(tx);
          },
          { maxWait: 5000, timeout: 60_000 },
        );
        return;
      } catch (err) {
        const state = sqlState(err);
        if (attempt >= 2 || (state !== '42P07' && state !== '23505')) throw err;
        await new Promise((resolve) => setTimeout(resolve, CATALOG_RACE_RETRY_MS));
      }
    }
  }

  /** Drops partitions older than the retention window; returns how many. A partition that cannot be dropped now is tried again at the next run. */
  async dropExpired(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = to_regclass('public.og_traffic_search')`;
    const expired = expiredPartitions(rows.map((r) => r.name), this.retentionDays(), now);
    let dropped = 0;
    for (const name of expired) {
      if (await this.step('partition_drop', name, () => this.dropPartition(name))) dropped += 1;
    }
    return dropped;
  }

  /**
   * `DROP TABLE` of a partition takes ACCESS EXCLUSIVE on the parent as well, so every search and insert waits behind
   * it. `lock_timeout` bounds that wait; a lock that is not granted is retried a few times a second apart, then left for
   * the next run (the partition is expired data, nothing needs it gone this minute). `SET LOCAL` ends with the transaction.
   */
  private async dropPartition(name: string): Promise<void> {
    const ddl = dropPartitionDdl(name);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${DROP_LOCK_TIMEOUT}'`);
          await tx.$executeRawUnsafe(ddl);
        });
        return;
      } catch (err) {
        if (!isLockTimeout(err) || attempt >= DROP_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, DROP_RETRY_MS));
      }
    }
  }

  retentionDays(): number {
    const configured = Number(this.configService.get<string>('ANALYTICS_RETENTION_DAYS'));
    return Number.isInteger(configured) && configured > 0 ? Math.min(configured, MAX_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS;
  }
}
