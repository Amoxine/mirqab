import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { jobRunsTotal, tykFanoutTotal } from '../../common/metrics/ops-metrics';
import type { RedisService } from '../../common/redis/redis.service';
import type { TykClientService } from '../tyk-integration/services/tyk-client.service';
import { certificateExpiry, MetricsService, parseInfoField } from './metrics.service';

jest.mock('@open-gateway/database', () => ({
  prisma: { apiDefinition: { findMany: jest.fn() }, $queryRaw: jest.fn() },
}));

// Redis answers INFO with CRLF line endings and `# Section` headers; the regex has to survive both.
const MEMORY_INFO = ['# Memory', 'used_memory:1048576', 'used_memory_human:1.00M', 'maxmemory:536870912', 'maxmemory_policy:noeviction', ''].join('\r\n');

describe('parseInfoField', () => {
  it('reads a field out of an INFO section', () => {
    expect(parseInfoField(MEMORY_INFO, 'used_memory')).toBe(1048576);
    expect(parseInfoField(MEMORY_INFO, 'maxmemory')).toBe(536870912);
  });

  it('does not match a longer field that merely starts with the name — maxmemory vs maxmemory_policy', () => {
    // Without the \b this returns null (maxmemory_policy:noeviction has no digits) or, worse for
    // used_memory, the value of used_memory_human. Both would silently break the R3 ratio alert.
    expect(parseInfoField(['# Memory', 'maxmemory_policy:noeviction', 'maxmemory:42'].join('\r\n'), 'maxmemory')).toBe(42);
  });

  it('is null for a field the section does not carry, rather than NaN', () => {
    expect(parseInfoField(MEMORY_INFO, 'evicted_keys')).toBeNull();
  });
});

describe('certificateExpiry', () => {
  // A real self-signed ECC root, shaped like the one Caddy's `tls internal` writes:
  // `openssl req -x509 -newkey ec ... -subj /CN=Open Gateway Test Root`, valid 2026-01-01 → 2036-01-01.
  const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIUc/N3oFU6fDHdNQK9AUFDMBQ62H4wCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWT3BlbiBHYXRld2F5IFRlc3QgUm9vdDAeFw0yNjAxMDEwMDAw
MDBaFw0zNjAxMDEwMDAwMDBaMCExHzAdBgNVBAMMFk9wZW4gR2F0ZXdheSBUZXN0
IFJvb3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQ9Cke7yzvSo/7jOY2/YGZ8
mPNnIntV64OeIKWHbKhKck9bhsD8zKUkQLR24NdRJK3H414dcLyaFnDLmbV9HSi7
o1MwUTAdBgNVHQ4EFgQUrJRZw0/JHCQt9ZdrUW2jlSQOa4QwHwYDVR0jBBgwFoAU
rJRZw0/JHCQt9ZdrUW2jlSQOa4QwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNIADBFAiEA5AsDl3Gptf38ksdFER0wu4034t8GGktc7KpUkp8060QCIEgs4mVr
NBNq3De4/8Jolg7qIL5r1ILFbTWFQ1N1bKkZ
-----END CERTIFICATE-----`;

  it('reads the CN and the expiry as a unix timestamp — the units the R14 rule compares to time()', () => {
    expect(certificateExpiry(ROOT_PEM)).toEqual({
      cn: 'Open Gateway Test Root',
      expiry: Date.UTC(2036, 0, 1) / 1000,
      lifetime: (Date.UTC(2036, 0, 1) - Date.UTC(2026, 0, 1)) / 1000,
      selfSigned: true,
    });
  });

  // WP29a: the leaf/intermediate rule divides remaining by THIS, so a wrong lifetime is a rule that
  // fires on a healthy certificate or never fires on a dead one. 10 years, from the dates above.
  it('reports the issued-for lifetime, which is what the fraction-of-lifetime rule divides by', () => {
    const { lifetime, expiry } = certificateExpiry(ROOT_PEM);
    expect(lifetime).toBe(3652 * 24 * 3600);
    // A certificate exactly at Caddy's renewal point has a third of its life left; the rule's 0.25
    // threshold must sit below that or it fires on every healthy renewal cycle.
    const atRenewal = expiry - lifetime / 3;
    expect((expiry - atRenewal) / lifetime).toBeGreaterThan(0.25);
  });

  it('marks a self-signed certificate, so a served root cannot overwrite the file-derived series', () => {
    expect(certificateExpiry(ROOT_PEM).selfSigned).toBe(true);
  });

  it('accepts DER as well as PEM — the TLS probe hands over raw bytes, not a file', () => {
    const der = Buffer.from(ROOT_PEM.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    expect(certificateExpiry(der).cn).toBe('Open Gateway Test Root');
  });

  it('throws on something that is not a certificate rather than reporting a bogus expiry', () => {
    // A metric that silently read 0 would make the R14 rule fire forever; refreshCertificates()
    // turns this throw into an ABSENT series instead.
    expect(() => certificateExpiry('not a certificate')).toThrow();
  });
});

describe('MetricsService scrape (OG-OBS-02 / C4)', () => {
  const db = prisma as unknown as {
    apiDefinition: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  // A credential in a node URL is the worst case for a label: it must never reach the exposition.
  const NODES = ['http://admin:s3cret@n1:8081/tyk', 'http://n2:8081/tyk'];
  const state = (hashes: Record<string, string>) => ({
    syncState: {
      checkedAt: '2026-09-27T00:00:00.000Z',
      inSync: false,
      nodes: Object.fromEntries(Object.entries(hashes).map(([url, hash]) => [url, { present: true, hash }])),
    },
  });

  /** Answers each analytics query by what it asks for; `table` false is Pump before its first purge. */
  function analyticsDb({ table = true, trigger = true, age = 42 as number | null } = {}) {
    db.$queryRaw.mockImplementation((query: Prisma.Sql) => {
      if (query.sql.includes('pg_trigger')) return Promise.resolve([{ present: trigger }]);
      if (query.sql.includes('raw_present')) return Promise.resolve([{ raw_present: table, aggregate_present: table }]);
      if (query.sql.includes('MAX("timestamp")')) return Promise.resolve([{ age_seconds: age }]);
      return Promise.reject(new Error(`unexpected query: ${query.sql}`));
    });
  }

  function makeService(reachable = [true, false]) {
    const redis = { getClient: () => ({ options: { host: 'redis' }, info: () => Promise.reject(new Error('down')) }) };
    const tykClient = {
      nodes: NODES,
      nodeHealth: () => Promise.resolve(NODES.map((nodeUrl, i) => ({ nodeUrl, health: { reachable: reachable[i] } }))),
    };
    const config = {
      get: (key: string, fallback: string) =>
        ({ EDGE_ROOT_CERT_PATH: '/nonexistent/root.crt', EDGE_TLS_PROBE: '127.0.0.1:1' })[key] ?? fallback,
    };
    return new MetricsService(
      redis as unknown as RedisService,
      tykClient as unknown as TykClientService,
      config as unknown as ConfigService,
    );
  }

  const scrape = async (service: MetricsService) => {
    await service.refresh();
    return service.registry.metrics();
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tykFanoutTotal.reset();
    jobRunsTotal.reset();
    // Node 2 is missing the second definition: node 1 stays in sync, node 2 does not.
    db.apiDefinition.findMany.mockResolvedValue([
      state({ [NODES[0]]: 'a', [NODES[1]]: 'a' }),
      state({ [NODES[0]]: 'b' }),
    ]);
    analyticsDb();
  });

  it('exposes every new metric with its bounded labels, next to the unchanged aggregates', async () => {
    const text = await scrape(makeService());

    expect(text).toContain('og_tyk_node_in_sync{node="tyk-1"} 1');
    expect(text).toContain('og_tyk_node_in_sync{node="tyk-2"} 0');
    expect(text).toContain('og_tyk_node_reachable{node="tyk-1"} 1');
    expect(text).toContain('og_tyk_node_reachable{node="tyk-2"} 0');
    expect(text).toContain('og_analytics_newest_record_age_seconds 42');
    expect(text).toContain('og_analytics_redaction_trigger_present 1');
    expect(text).toContain('og_tyk_fanout_total{node="tyk-2",operation="upsertOasApi",outcome="circuit_open"} 0');
    expect(text).toContain('og_job_runs_total{task="reconcile",outcome="error"} 0');
    expect(text).toContain('og_job_runs_total{task="spec_source_fetch",outcome="ok"} 0');
    expect(text).toContain('og_authz_denied_total{reason="tenant_mismatch"} 0');
    // EX-07 reads these two; they must not change shape.
    expect(text).toContain('gateway_nodes_total 2');
    expect(text).toContain('gateway_nodes_in_sync 1');
  });

  it('uses neither of the labels Prometheus attaches to every target (job, instance)', async () => {
    const service = makeService();
    await service.refresh();

    const labelNames = (await service.registry.getMetricsAsJSON()).flatMap((metric) =>
      metric.values.flatMap((value) => Object.keys(value.labels)),
    );
    expect(labelNames).toEqual(expect.arrayContaining(['node', 'task', 'reason']));
    expect(labelNames).not.toContain('job');
    expect(labelNames).not.toContain('instance');
  });

  it('never puts a URL in a label, and every label value is from a closed set', async () => {
    const text = await scrape(makeService());
    const ours = text.split('\n').filter((line) => /^og_(tyk|job|authz|analytics|traffic)_/.test(line));

    expect(ours.length).toBeGreaterThan(0);
    expect(text).not.toContain('://');
    expect(text).not.toContain('s3cret');
    for (const line of ours) {
      for (const [, name, value] of line.matchAll(/(\w+)="([^"]*)"/g)) {
        expect([name, value]).toEqual([name, expect.stringMatching(
          {
            node: /^tyk-[12]$/,
            operation: /^[a-zA-Z]+$/,
            outcome: /^(ok|error|circuit_open)$/,
            task: /^(reconcile|health_check|metering|quota_reset|key_expiry|analytics_retention|spec_source_fetch|search_index|search_maintenance)$/,
            reason: /^(tenant_mismatch|missing_permission|no_tenant)$/,
            phase: /^(create|partition_create|partition_drop)$/,
          }[name] ?? /^$/,
        )]);
      }
    }
  });

  it('takes both nodes out of sync on a hash conflict, as the aggregate does', async () => {
    db.apiDefinition.findMany.mockResolvedValue([state({ [NODES[0]]: 'a', [NODES[1]]: 'z' })]);

    const text = await scrape(makeService());

    expect(text).toContain('og_tyk_node_in_sync{node="tyk-1"} 0');
    expect(text).toContain('og_tyk_node_in_sync{node="tyk-2"} 0');
    expect(text).toContain('gateway_nodes_in_sync 0');
  });

  it('has no age or trigger sample while tyk_analytics is absent, and asks nothing more of it', async () => {
    const service = makeService();
    await scrape(service); // both populated first, so the next scrape has to actively drop them
    jest.clearAllMocks();
    analyticsDb({ table: false, trigger: false });

    const text = await scrape(service);

    expect(text).not.toMatch(/^og_analytics_newest_record_age_seconds /m);
    expect(text).not.toMatch(/^og_analytics_redaction_trigger_present /m);
    expect(db.$queryRaw.mock.calls.map(([q]: [Prisma.Sql]) => q.sql)).toEqual([expect.stringContaining('raw_present')]);
  });

  it('reports a missing trigger as 0 once the table exists (AL-PUMP-04)', async () => {
    analyticsDb({ trigger: false });
    expect(await scrape(makeService())).toContain('og_analytics_redaction_trigger_present 0');
  });

  it('has no age sample for an empty table, rather than a fake 0', async () => {
    analyticsDb({ age: null });
    expect(await scrape(makeService())).not.toMatch(/^og_analytics_newest_record_age_seconds /m);
  });

  it('drops the per-node in-sync and analytics series when the DB is down instead of keeping stale values', async () => {
    const service = makeService();
    await scrape(service);
    db.apiDefinition.findMany.mockRejectedValue(new Error('db down'));
    db.$queryRaw.mockRejectedValue(new Error('db down'));

    const text = await scrape(service);

    expect(text).not.toMatch(/^og_tyk_node_in_sync\{/m);
    expect(text).not.toMatch(/^og_analytics_newest_record_age_seconds /m);
    expect(text).not.toMatch(/^og_analytics_redaction_trigger_present /m);
    expect(text).toContain('gateway_nodes_total 2');
  });
});
