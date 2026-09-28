import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Gauge } from 'prom-client';
import { countJobRun } from '../../../common/metrics/ops-metrics';
import { MetricsService } from '../../observability/metrics.service';
import { SpecSourceService } from './spec-source.service';

export const SPEC_CHECK_TICK_MS = 60_000;
/** Work per tick. A single check can take the fetcher's 10 s plus a synchronous lint of up to 5 MB. */
export const SPEC_CHECK_TICK_BUDGET_MS = 45_000;
/**
 * The most of a tick's budget one tenant may use: half, or all of it when it is the only tenant due.
 * Round-robin alone shares by COUNT, so one tenant with many slow-but-OK sources would take most of
 * every tick. Checked before each check starts, so a tenant can overrun its share by one check (≤ the
 * fetcher's 10 s plus a lint).
 */
export function tenantShareMs(tenantsDue: number): number {
  return SPEC_CHECK_TICK_BUDGET_MS * Math.max(1 / 2, 1 / Math.max(1, tenantsDue));
}

/** Due sources read per tick; what the budget does not reach stays due for the next one. */
const DUE_READ_LIMIT = 200;

/** Interleaves tenants (a, b, a, b, a…) so one tenant with many due sources cannot starve the others. */
export function roundRobinByTenant<T extends { tenantId: string }>(rows: readonly T[]): T[] {
  const queues = new Map<string, T[]>();
  for (const row of rows) {
    const queue = queues.get(row.tenantId);
    if (queue) queue.push(row);
    else queues.set(row.tenantId, [row]);
  }
  const out: T[] = [];
  for (let round = 0; out.length < rows.length; round += 1) {
    for (const queue of queues.values()) {
      if (round < queue.length) out.push(queue[round]);
    }
  }
  return out;
}

/**
 * OAS-08: checks watched spec URLs every minute. In-process `running` guard (a slow tick is skipped,
 * never overlapped), a time budget per tick, per-tenant fairness. Cross-replica safety is the claim in
 * `SpecSourceService.claimAndCheck`, not this guard.
 */
@Injectable()
export class SpecSourceScheduler {
  private readonly logger = new Logger(SpecSourceScheduler.name);
  private running = false;
  private readonly oldestOverdue: Gauge;
  /** Replaced in tests. */
  clock: () => number = Date.now;

  constructor(
    private readonly sources: SpecSourceService,
    metrics: MetricsService,
  ) {
    this.oldestOverdue = new Gauge({
      name: 'og_spec_source_oldest_overdue_seconds',
      help: 'How long the most overdue enabled spec source has been waiting for its check (0 when none is due)',
      registers: [metrics.registry],
    });
  }

  @Interval(SPEC_CHECK_TICK_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await countJobRun('spec_source_fetch', () => this.sweep());
    } catch (err) {
      this.logger.error(`Spec source sweep failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<void> {
    const started = this.clock();
    const { now, sources } = await this.sources.due(DUE_READ_LIMIT);
    this.oldestOverdue.set(sources.length > 0 ? Math.max(0, (now.getTime() - sources[0].nextCheckAt.getTime()) / 1000) : 0);

    const order = roundRobinByTenant(sources);
    const share = tenantShareMs(new Set(order.map((source) => source.tenantId)).size);
    const spent = new Map<string, number>();
    for (const source of order) {
      if (this.clock() - started >= SPEC_CHECK_TICK_BUDGET_MS) break;
      if ((spent.get(source.tenantId) ?? 0) >= share) continue; // stays due: next tick
      const began = this.clock();
      try {
        await this.sources.claimAndCheck(source);
      } catch (err) {
        // The claim already advanced next_check_at: this source is retried at its next interval.
        // The error's name only — a message could quote the URL.
        this.logger.warn(`Spec source ${source.id} check aborted: ${err instanceof Error ? err.name : 'unknown error'}`);
      }
      spent.set(source.tenantId, (spent.get(source.tenantId) ?? 0) + this.clock() - began);
    }
  }
}
