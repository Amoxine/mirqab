import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PUMP_HEALTH_TIMEOUT_MS = 3000;

/**
 * Liveness probe for Tyk Pump: `GET {PUMP_HEALTH_URL}` (pump v1.17 serves `/health` on :8083, e.g.
 * `http://tyk-pump:8083/health` over the compose network). This is what distinguishes "pump stopped"
 * from "gateway idle" — table freshness cannot, because an idle gateway also has old rows.
 *
 * Never throws and is deliberately NOT circuit-broken (same contract as `gatewayHealth()`): a stopped
 * pump is the exact state this probe exists to report. Unset URL, network error, timeout and non-2xx
 * all read as "not reachable".
 */
@Injectable()
export class PumpHealthService {
  private readonly logger = new Logger(PumpHealthService.name);
  private readonly healthUrl: string;

  constructor(configService: ConfigService) {
    this.healthUrl = configService.get('PUMP_HEALTH_URL', '');
  }

  async isReachable(): Promise<boolean> {
    if (!this.healthUrl) return false;

    try {
      const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(PUMP_HEALTH_TIMEOUT_MS) });
      await response.text();
      return response.ok;
    } catch (err) {
      // debug, not warn: the dashboard polls /analytics/health, so a stopped pump would flood the log.
      this.logger.debug(`Pump health probe failed: ${err instanceof Error ? err.name : 'unknown error'}`);
      return false;
    }
  }
}
