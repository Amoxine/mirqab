import { Injectable } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { RedisService } from './common/redis/redis.service';
import { TykClientService } from './modules/tyk-integration/services/tyk-client.service';

export interface DependencyStatus {
  status: 'up' | 'down';
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unhealthy';
  timestamp: string;
  checks: Record<'postgres' | 'redis' | 'gateway', DependencyStatus>;
}

/** Bound on each probe. The Docker HEALTHCHECK gives the whole endpoint 10 s. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * `.unref()` so a probe that outlives its request never holds the process open at shutdown.
 * Prisma's own `connect_timeout` is 5 s, which is longer than a readiness answer should take.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`probe timed out after ${String(ms)}ms`));
      }, ms).unref();
    }),
  ]);
}

function down(err: unknown): DependencyStatus {
  return { status: 'down', error: err instanceof Error ? err.message : String(err) };
}

@Injectable()
export class AppService {
  constructor(
    private readonly redis: RedisService,
    private readonly tykClient: TykClientService,
  ) {}

  /**
   * `GET /api/health` (WP20).
   *
   * This used to answer a static `{status:'ok'}` that was true the instant the process had booted
   * and never again — the container reported healthy with Postgres gone. It now reports what it
   * actually reached: Postgres, Redis and the gateway's own `/hello`. The controller turns a
   * non-`ok` verdict into 503, which is what makes the Docker HEALTHCHECK mean something.
   *
   * All three run concurrently and none can throw out of here: an unreachable dependency is the
   * answer, not an error.
   */
  async getReadiness(): Promise<ReadinessReport> {
    const [postgres, redis, gateway] = await Promise.all([
      withTimeout(prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS).then(
        (): DependencyStatus => ({ status: 'up' }),
        down,
      ),
      this.redis
        .healthCheck()
        .then((health): DependencyStatus => (health.status === 'up' ? { status: 'up' } : down(health.error)), down),
      this.tykClient
        .gatewayHealth()
        .then(
          (health): DependencyStatus =>
            health.reachable ? { status: 'up' } : down(health.error ?? 'gateway unreachable'),
          down,
        ),
    ]);

    const checks = { postgres, redis, gateway };
    return {
      status: Object.values(checks).every((check) => check.status === 'up') ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  /** Liveness only: the process is up and answering. `GET /api` — deliberately not a readiness check. */
  getLiveness(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
