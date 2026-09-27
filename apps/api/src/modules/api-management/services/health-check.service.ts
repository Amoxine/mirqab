import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiHealthStatus } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { recordJobRun } from '../../../common/metrics/ops-metrics';
import type { ApiUptimeTestDto } from '../dto/api-config.dto';

/** How often uptime tests run. `healthStatus` must reflect a downed upstream within one interval. */
export const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Default probe timeout when an uptime test does not set one. */
const DEFAULT_TIMEOUT_SECONDS = 5;

/**
 * Turn probe outcomes into the column the UI reads.
 *
 * Three states rather than up/down because an API can have several upstream probes: all passing is
 * HEALTHY, none passing is DOWN, and a mix is DEGRADED — which is the case an operator most wants
 * to see, and the one a boolean would hide.
 */
export function healthFrom(results: boolean[]): ApiHealthStatus {
  // No probes configured means no evidence. Reporting HEALTHY here would be an assertion nothing
  // checked, which is exactly how `healthStatus` came to be permanently UNKNOWN-or-lying before.
  if (results.length === 0) return ApiHealthStatus.UNKNOWN;
  if (results.every(Boolean)) return ApiHealthStatus.HEALTHY;
  if (results.every((ok) => !ok)) return ApiHealthStatus.DOWN;
  return ApiHealthStatus.DEGRADED;
}

/**
 * Computes `ApiDefinition.healthStatus`, which nothing populated before WP15a.
 *
 * This probes the configured uptime-test URLs FROM THE API rather than reading Tyk's own
 * host-checker state. Tyk does run its own uptime tests — that is what feeds
 * `loadBalancing.skipUnavailableHosts`, so both are wanted — but on OSS with no Dashboard those
 * results are only in Redis under undocumented keys, and depending on their shape would make this
 * column silently wrong the first time Tyk changed them. A direct probe is a few lines, needs no
 * reverse engineering, and is honest about what it measured.
 */
@Injectable()
export class HealthCheckService {
  private readonly logger = new Logger(HealthCheckService.name);

  /** Probe one upstream. Any non-2xx/3xx, timeout or connection failure counts as down. */
  private async probe(test: ApiUptimeTestDto): Promise<boolean> {
    try {
      const res = await fetch(test.url, {
        method: test.method ?? 'GET',
        signal: AbortSignal.timeout((test.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
      });
      return res.status < 400;
    } catch {
      return false;
    }
  }

  /** Recompute one API's health from its configured probes. Returns the status it stored. */
  async checkOne(apiDefId: string, tests: ApiUptimeTestDto[]): Promise<ApiHealthStatus> {
    const results = await Promise.all(tests.map((t) => this.probe(t)));
    const healthStatus = healthFrom(results);

    await prisma.apiDefinition.update({ where: { id: apiDefId }, data: { healthStatus } });
    return healthStatus;
  }

  @Interval(HEALTH_CHECK_INTERVAL_MS)
  async checkAll(): Promise<void> {
    // A down upstream is a result, not a failure (`probe` never throws); `ok` goes false only when
    // the sweep or one API's write throws.
    let ok = false;
    try {
      const defs = await prisma.apiDefinition.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, config: true },
      });
      ok = true;

      for (const def of defs) {
        const config = def.config as { uptimeTests?: ApiUptimeTestDto[] | null } | null;
        const tests = config?.uptimeTests ?? [];
        // An API with no probes keeps whatever it had rather than being reset to UNKNOWN on every
        // tick — there is nothing new to say about it.
        if (tests.length === 0) continue;
        try {
          await this.checkOne(def.id, tests);
        } catch (err) {
          ok = false;
          this.logger.warn(
            `Health check of ${def.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      recordJobRun('health_check', ok);
    }
  }
}
