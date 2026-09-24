import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { prisma } from '@open-gateway/database';
import { RedisService } from '../../common/redis/redis.service';
import { TykClientService } from '../tyk-integration/services/tyk-client.service';
import { nodesInSync, type SyncState } from '../api-management/services/reconcile.service';

/** Where the edge's exported root CA lands in the api container (`infra/docker-compose.yml`). */
const DEFAULT_EDGE_ROOT_CERT = '/etc/open-gateway/edge-root.crt';

/** `INFO` answers `field:value\r\n` lines; the sections are headed `# Memory` etc. */
export function parseInfoField(info: string, field: string): number | null {
  const match = new RegExp(`^${field}:(\\d+)\\b`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

/** Seconds since the epoch at which a PEM certificate stops being valid. */
export function certificateExpiry(pem: string): { cn: string; expiry: number } {
  const cert = new X509Certificate(pem);
  return {
    cn: /CN=([^,\n]+)/.exec(cert.subject)?.[1]?.trim() ?? cert.subject,
    expiry: Math.floor(Date.parse(cert.validTo) / 1000),
  };
}

/**
 * The `/api/metrics` registry (WP20).
 *
 * Every series here exists because a Prometheus rule reads it — Grafana was cut (§9), so a metric
 * nothing alerts on has no viewer at all. The three collectors are the three things §5 says go
 * wrong silently: Redis filling or evicting (R3), a node holding a different definition from its
 * peers (R2), and the edge's CA expiring (R14).
 *
 * Collection is explicit (`refresh()` from the controller) rather than prom-client's per-metric
 * `collect` hook: all three touch the network or disk, and one call site makes the scrape's cost
 * and failure handling obvious instead of spreading it over six gauges.
 *
 * On a failed probe the affected gauges are RESET, not left holding their last value. A stale
 * `redis_used_memory_bytes` reads as a healthy Redis to a rule that cannot tell the difference; an
 * absent series reads as absent, which is the truth.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  readonly registry = new Registry();

  private readonly edgeRootCertPath: string;

  private readonly redisUsedMemory = new Gauge({
    name: 'redis_used_memory_bytes',
    help: 'Redis used_memory, per instance',
    labelNames: ['redis'],
    registers: [this.registry],
  });

  private readonly redisMaxMemory = new Gauge({
    name: 'redis_maxmemory_bytes',
    help: 'Redis maxmemory, per instance (0 when unbounded)',
    labelNames: ['redis'],
    registers: [this.registry],
  });

  // Not `_total`: this is Redis' own cumulative counter read as a point-in-time value, and naming it
  // like a prom-client Counter would promise a reset semantic this gauge does not have.
  private readonly redisEvictedKeys = new Gauge({
    name: 'redis_evicted_keys',
    help: 'Redis evicted_keys since the server started, per instance (R3)',
    labelNames: ['redis'],
    registers: [this.registry],
  });

  private readonly gatewayNodesTotal = new Gauge({
    name: 'gateway_nodes_total',
    help: 'Gateway nodes the control plane fans out to (TYK_ADMIN_URLS)',
    registers: [this.registry],
  });

  private readonly gatewayNodesInSync = new Gauge({
    name: 'gateway_nodes_in_sync',
    help: 'Gateway nodes holding every reconciled definition identically (R2)',
    registers: [this.registry],
  });

  private readonly certExpiry = new Gauge({
    name: 'edge_certificate_expiry_timestamp_seconds',
    help: 'Unix time at which an edge certificate expires (R14)',
    labelNames: ['cn', 'role'],
    registers: [this.registry],
  });

  constructor(
    private readonly redis: RedisService,
    private readonly tykClient: TykClientService,
    configService: ConfigService,
  ) {
    this.edgeRootCertPath = configService.get('EDGE_ROOT_CERT_PATH', DEFAULT_EDGE_ROOT_CERT);
    collectDefaultMetrics({ register: this.registry });
  }

  async refresh(): Promise<void> {
    await Promise.all([this.refreshRedis(), this.refreshGatewaySync(), this.refreshCertificates()]);
  }

  /**
   * One series per Redis instance, keyed by the connection's host.
   *
   * There is exactly one instance today: spike S4(c) proved Tyk OSS 5.15 ignores
   * `TYK_GW_ANALYTICSSTORAGE_*`, so the keys/quota and analytics-buffer split R3 asks for does not
   * exist and the single instance runs `noeviction` (see `infra/docker-compose.yml`). The label is
   * still here so a second instance would add a series rather than need a new rule — the alerts are
   * written over every series, which is "both instances" whenever there are two.
   */
  private async refreshRedis(): Promise<void> {
    const client = this.redis.getClient();
    const name = client.options.host ?? 'redis';
    try {
      const [memory, stats] = await Promise.all([client.info('memory'), client.info('stats')]);
      const used = parseInfoField(memory, 'used_memory');
      const max = parseInfoField(memory, 'maxmemory');
      const evicted = parseInfoField(stats, 'evicted_keys');
      if (used !== null) this.redisUsedMemory.set({ redis: name }, used);
      if (max !== null) this.redisMaxMemory.set({ redis: name }, max);
      if (evicted !== null) this.redisEvictedKeys.set({ redis: name }, evicted);
    } catch (err) {
      this.redisUsedMemory.reset();
      this.redisMaxMemory.reset();
      this.redisEvictedKeys.reset();
      this.logger.debug(`Redis metrics unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refreshGatewaySync(): Promise<void> {
    const nodes = [...this.tykClient.nodes];
    this.gatewayNodesTotal.set(nodes.length);
    try {
      // Same row set reconcile writes: `tykApiId` non-null. Filtering on `syncState` itself would
      // mean Prisma's Json-null filters (DbNull vs JsonNull), which is a trap for one `.filter()`.
      const rows = await prisma.apiDefinition.findMany({
        where: { tykApiId: { not: null } },
        select: { syncState: true },
      });
      const states = rows
        .map((row) => row.syncState as unknown as SyncState | null)
        .filter((state): state is SyncState => state !== null);
      this.gatewayNodesInSync.set(nodesInSync(states, nodes));
    } catch (err) {
      this.gatewayNodesInSync.reset();
      this.logger.debug(`Sync metrics unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The edge's ROOT CA, read from the file clients are told to trust (`infra/edge/root.crt`).
   *
   * Only the root, and that is a measured choice rather than an omission: Caddy's `tls internal`
   * issues 12-HOUR leaves off a 7-DAY intermediate (verified on the running edge), so R14's "alert
   * at 14 days remaining" is permanently true for both of them and would be a permanently firing
   * alert. The root is the one certificate where 14 days is a meaningful warning — it lasts 10
   * years, every client installs it by hand, and its expiry breaks all of them at once.
   *
   * Re-read on every scrape, not cached at boot, so replacing the file moves the metric.
   */
  private async refreshCertificates(): Promise<void> {
    try {
      const { cn, expiry } = certificateExpiry(await readFile(this.edgeRootCertPath, 'utf8'));
      this.certExpiry.reset();
      this.certExpiry.set({ cn, role: 'root' }, expiry);
    } catch (err) {
      this.certExpiry.reset();
      this.logger.debug(
        `Edge root certificate unreadable at ${this.edgeRootCertPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
