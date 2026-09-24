import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect as tlsConnect, type DetailedPeerCertificate } from 'node:tls';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { prisma } from '@open-gateway/database';
import { RedisService } from '../../common/redis/redis.service';
import { TykClientService } from '../tyk-integration/services/tyk-client.service';
import { nodesInSync, type SyncState } from '../api-management/services/reconcile.service';

/** Where the edge's exported root CA lands in the api container (`infra/docker-compose.yml`). */
const DEFAULT_EDGE_ROOT_CERT = '/etc/open-gateway/edge-root.crt';

/**
 * The edge's own HTTPS listener, dialled to read back the certificate it actually SERVES.
 * `localhost` is what `tls internal` issues for, so it is the SNI even though the host is `edge`.
 */
const DEFAULT_EDGE_TLS_PROBE = 'edge:33001';

/** `INFO` answers `field:value\r\n` lines; the sections are headed `# Memory` etc. */
export function parseInfoField(info: string, field: string): number | null {
  const match = new RegExp(`^${field}:(\\d+)\\b`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

/**
 * When a certificate expires and how long it was issued for, both in seconds.
 *
 * `lifetime` is what makes a FRACTION-of-lifetime rule possible (WP29a). An absolute
 * days-remaining threshold cannot express the edge's leaf at all — it lives 12 hours, so every
 * threshold worth warning about is either permanently true or shorter than the renewal interval.
 * `remaining / lifetime` is scale-free: it reads the same on a 12-hour leaf, a 7-day intermediate
 * and a 10-year root, and it is the only form that answers the question R14 actually asks, which is
 * "is renewal still happening?" rather than "how far away is the cliff?".
 *
 * Takes DER as well as PEM so the same function serves the exported root FILE and the raw
 * certificate read off a live TLS handshake.
 */
export function certificateExpiry(pem: string | Buffer): {
  cn: string;
  expiry: number;
  lifetime: number;
  selfSigned: boolean;
} {
  const cert = new X509Certificate(pem);
  const from = Math.floor(Date.parse(cert.validFrom) / 1000);
  const expiry = Math.floor(Date.parse(cert.validTo) / 1000);
  // Caddy's `tls internal` leaves carry NO subject at all — identity is in the SAN — so the CN
  // fallback has to reach the SAN before it gives up, or every leaf series is labelled cn="".
  // An EMPTY match has to fall through like a missing one, which is why this is a find over
  // candidates rather than `??`: `??` would stop at the empty string the subject-less leaf yields.
  const cn =
    [
      /CN=([^,\n]+)/.exec(cert.subject)?.[1]?.trim(),
      /DNS:([^,\n]+)/.exec(cert.subjectAltName ?? '')?.[1]?.trim(),
      cert.subject,
    ].find((candidate) => candidate !== undefined && candidate !== '') ?? 'unknown';
  return { cn, expiry, lifetime: expiry - from, selfSigned: cert.issuer === cert.subject };
}

/**
 * The certificate chain the edge serves, leaf first, without trusting it.
 *
 * `rejectUnauthorized: false` is deliberate and is not a weakened check: this connection carries no
 * data and exists only to read the chain. Verifying it would make the probe fail exactly when the
 * certificate is broken — which is the case the metric has to REPORT, not refuse to look at.
 */
export async function peerChain(hostPort: string, timeoutMs = 5000): Promise<Buffer[]> {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host, port: Number(port), servername: 'localhost', rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const chain: Buffer[] = [];
        // `@types/node` types `issuerCertificate` as always present. It is not: on the last
        // certificate of a served chain Node leaves it self-referential or empty, and Caddy does
        // not send the root at all. The cast widens the type to the truth — the guard below is a
        // real runtime check, not one being skipped.
        let cert = socket.getPeerCertificate(true) as DetailedPeerCertificate | undefined;
        // The stop condition is a fixed point, not a length: a self-signed certificate issues
        // itself, so walking `issuerCertificate` unconditionally never terminates.
        while (cert?.raw) {
          const raw = cert.raw;
          if (chain.some((seen) => seen.equals(raw))) break;
          chain.push(raw);
          cert = cert.issuerCertificate as DetailedPeerCertificate | undefined;
        }
        socket.destroy();
        resolve(chain);
      },
    );
    socket.on('timeout', () => socket.destroy(new Error(`TLS probe of ${hostPort} timed out`)));
    socket.on('error', reject);
  });
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

  // Same label set as the gauge above, so a rule can divide one by the other without a `on()`
  // clause. That division IS the WP29a rule: remaining / lifetime.
  private readonly certLifetime = new Gauge({
    name: 'edge_certificate_lifetime_seconds',
    help: 'Total validity period an edge certificate was issued for (WP29a)',
    labelNames: ['cn', 'role'],
    registers: [this.registry],
  });

  private readonly edgeTlsProbe: string;

  constructor(
    private readonly redis: RedisService,
    private readonly tykClient: TykClientService,
    configService: ConfigService,
  ) {
    this.edgeRootCertPath = configService.get('EDGE_ROOT_CERT_PATH', DEFAULT_EDGE_ROOT_CERT);
    this.edgeTlsProbe = configService.get('EDGE_TLS_PROBE', DEFAULT_EDGE_TLS_PROBE);
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
   * Two sources, because the edge has two different expiry problems and neither can answer the
   * other's question.
   *
   * The ROOT comes from the FILE clients are told to trust (`infra/edge/root.crt`): it lasts 10
   * years, every client installs it by hand, and its expiry breaks all of them at once. WP20's
   * absolute 14-day rule is the right shape for that one and only that one.
   *
   * The LEAF (12 h) and INTERMEDIATE (7 d) come from a TLS handshake with the edge, and they are
   * read from the wire rather than from disk on purpose: `tls internal` issues them lazily and
   * renews them automatically, so the only honest way to ask "is renewal still working?" is to look
   * at what is being served right now. A 12-hour certificate cannot be watched with a
   * days-remaining threshold at all — hence `certLifetime` and a fraction rule (see
   * observability/rules/open-gateway.yml). If renewal stops, the served leaf's remaining fraction
   * falls until it crosses the threshold; if renewal works, it snaps back to 1 every few hours.
   *
   * Both are re-read on every scrape rather than cached, so replacing the file or renewing the leaf
   * moves the metric on the next one. The two gauges are RESET together and repopulated per source,
   * so a failed TLS probe drops the leaf series without also dropping the root.
   */
  private async refreshCertificates(): Promise<void> {
    this.certExpiry.reset();
    this.certLifetime.reset();

    try {
      const { cn, expiry, lifetime } = certificateExpiry(await readFile(this.edgeRootCertPath, 'utf8'));
      this.certExpiry.set({ cn, role: 'root' }, expiry);
      this.certLifetime.set({ cn, role: 'root' }, lifetime);
    } catch (err) {
      this.logger.debug(
        `Edge root certificate unreadable at ${this.edgeRootCertPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const chain = await peerChain(this.edgeTlsProbe);
      chain.forEach((der, index) => {
        const { cn, expiry, lifetime, selfSigned } = certificateExpiry(der);
        // Measured on this edge: Caddy serves [leaf, intermediate] and does NOT send the root, so
        // the skip below is defensive rather than load-bearing — but a served root would otherwise
        // overwrite the file-derived series above with the same labels, quietly replacing the
        // certificate clients installed with whatever the edge happens to present.
        if (selfSigned) return;
        const role = index === 0 ? 'leaf' : 'intermediate';
        this.certExpiry.set({ cn, role }, expiry);
        this.certLifetime.set({ cn, role }, lifetime);
      });
    } catch (err) {
      this.logger.debug(
        `Edge TLS probe of ${this.edgeTlsProbe} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
