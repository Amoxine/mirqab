import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { prisma } from '@open-gateway/database';
import { AuditService } from '../../audit/services/audit.service';

/** One key's usage as the pump recorded it. */
interface KeyUsageRow {
  dimension_value: string;
  hits: bigint;
}

/**
 * Meters real gateway traffic into `Quota.used` (WP18, owner decision O6: metering only, no
 * billing).
 *
 * Source is the pump's `tyk_aggregated` table, `dimension = 'apikeys'`, whose `dimension_value` is
 * the key's Tyk id and `counter_hits` the request count. `tyk_aggregated` is Pump-owned and
 * deliberately unmodelled in Prisma (schema.prisma's "do not re-add them"), so it is read with
 * `$queryRaw` — that is the intended access path here, not a shortcut around the ORM.
 *
 * **It SETS `used` to the period total rather than adding a delta, and that is deliberate.** A
 * delta needs a watermark, and a watermark makes the job non-idempotent in both directions: a
 * missed run under-counts forever, a double run double-counts forever, and neither is detectable
 * afterwards. Summing everything since the quota's period began is idempotent, self-healing after
 * an outage, and cannot drift — the counter always equals what the gateway actually recorded.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(private readonly auditService: AuditService) {}

  /**
   * Hourly. The window matters less than it looks: because each run recomputes the period total
   * rather than accumulating, the interval only sets how stale `used` can be, never its accuracy.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleMeterUsage(): Promise<void> {
    try {
      const updated = await this.meterAll();
      if (updated > 0) this.logger.log(`Metered usage for ${String(updated)} quota(s)`);
    } catch (err) {
      // A metering failure must not take the process down — the counter is reporting, not enforcement
      // (the gateway enforces its own quota from the key/policy regardless of this number).
      this.logger.error(`Metering run failed: ${String(err)}`);
    }
  }

  /**
   * Recompute `used` for every active quota. Returns how many rows were written.
   *
   * Quotas whose key has never reached the gateway (`tykKeyId` null) are skipped rather than zeroed:
   * a key that has not been issued yet has no usage to report, which is not the same as having used
   * nothing this period.
   */
  async meterAll(): Promise<number> {
    const quotas = await prisma.quota.findMany({
      select: {
        id: true,
        used: true,
        limit: true,
        resetAt: true,
        period: true,
        apiKey: { select: { tykKeyId: true, tenantId: true, id: true, name: true } },
      },
    });

    // flatMap, not filter: it narrows `tykKeyId` to `string` in the result type, so the rest of the
    // method needs no non-null assertion to say what the filter already guaranteed.
    const metered = quotas.flatMap((q) =>
      q.apiKey.tykKeyId === null
        ? []
        : [
            {
              id: q.id,
              used: q.used,
              limit: q.limit,
              resetAt: q.resetAt,
              tykKeyId: q.apiKey.tykKeyId,
              tenantId: q.apiKey.tenantId,
              apiKeyId: q.apiKey.id,
              apiKeyName: q.apiKey.name,
            },
          ],
    );
    if (metered.length === 0) return 0;

    // One query for every key, not one per quota: the alternative is N round trips per run.
    const keyIds = metered.map((q) => q.tykKeyId);
    const periodStart = this.earliestPeriodStart(metered.map((q) => q.resetAt));

    const rows = await prisma.$queryRaw<KeyUsageRow[]>`
      SELECT dimension_value, SUM(counter_hits)::bigint AS hits
      FROM tyk_aggregated
      WHERE dimension = 'apikeys'
        AND dimension_value = ANY(${keyIds})
        AND timestamp >= ${periodStart}
      GROUP BY dimension_value
    `;

    const hitsByKey = new Map(rows.map((r) => [r.dimension_value, Number(r.hits)]));

    let written = 0;
    for (const quota of metered) {
      const used = hitsByKey.get(quota.tykKeyId) ?? 0;
      if (used === quota.used) continue; // nothing changed; skip the write

      // Audited once per crossing, not once per hour while it stays over: only the under→over edge
      // qualifies. A quota already over limit before this run (used unchanged, caught above) does
      // not re-fire, and neither does a quota that drops back under after its period resets.
      if (quota.used < quota.limit && used >= quota.limit) {
        await this.auditService.record({
          tenantId: quota.tenantId,
          action: 'QUOTA_EXCEEDED',
          resource: 'keys',
          details: { apiKeyId: quota.apiKeyId, apiKeyName: quota.apiKeyName, used, limit: quota.limit },
        });
      }

      await prisma.quota.update({ where: { id: quota.id }, data: { used } });
      written += 1;
    }
    return written;
  }

  /**
   * The oldest period start across all quotas, so one query covers every one of them. Each quota's
   * `resetAt` is the END of its current period, so the start is `resetAt` minus its length.
   *
   * Over-reading is safe and under-reading is not: a window that starts too early only pulls rows
   * that the per-key GROUP BY then attributes correctly, while one that starts too late silently
   * loses usage. Hence the earliest, not the latest.
   */
  private earliestPeriodStart(resetAts: Date[]): Date {
    const MAX_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // MONTHLY, the longest QuotaPeriod
    const earliestReset = resetAts.reduce((a, b) => (a < b ? a : b), resetAts[0]);
    return new Date(earliestReset.getTime() - MAX_PERIOD_MS);
  }
}
