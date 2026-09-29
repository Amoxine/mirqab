import 'reflect-metadata';
import type { PrismaClient } from '@prisma/client';
import type { AnalyticsTrafficQueryDto } from '../dto/analytics-query.dto';
import { TrafficAnalyticsService } from './traffic-analytics.service';

function makeService(opts: { apiFound?: boolean; keyFound?: boolean; rows?: unknown[][] } = {}) {
  const queryRaw = jest.fn();
  for (const r of opts.rows ?? []) queryRaw.mockResolvedValueOnce(r);
  queryRaw.mockResolvedValue([]);
  const prisma = {
    apiDefinition: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.apiFound === false ? null : { tykApiId: 'tyk-1' }),
      findMany: jest.fn().mockResolvedValue([{ tykApiId: 'tyk-1' }, { tykApiId: null }]),
    },
    apiKey: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.keyFound === false ? null : { tykKeyId: 'hash-1' }),
    },
    $queryRaw: queryRaw,
  };
  return {
    service: new TrafficAnalyticsService(prisma as unknown as PrismaClient),
    prisma,
    queryRaw,
  };
}

const query = (extra: Partial<AnalyticsTrafficQueryDto> = {}) =>
  ({ range: '24h', ...extra }) as AnalyticsTrafficQueryDto;

describe('TrafficAnalyticsService', () => {
  it('returns an empty result without SQL when the tenant has no synced API', async () => {
    const { service, prisma, queryRaw } = makeService();
    prisma.apiDefinition.findMany.mockResolvedValue([]);
    const out = await service.getTraffic('t1', query());
    expect(out.summary.requests).toBe(0);
    expect(out.statusClasses.map((c) => c.count)).toEqual([0, 0, 0, 0]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("matches nothing for an api or key id that is not the caller's tenant's", async () => {
    const other = makeService({ apiFound: false });
    expect((await other.service.getTraffic('t1', query({ apiId: 'x' }))).summary.requests).toBe(0);
    expect(other.prisma.apiDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'x', tenantId: 't1' } }),
    );
    expect(other.queryRaw).not.toHaveBeenCalled();

    const key = makeService({ keyFound: false });
    await key.service.getTraffic('t1', query({ keyId: 'k' }));
    expect(key.prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'k', tenantId: 't1' } }),
    );
    expect(key.queryRaw).not.toHaveBeenCalled();
  });

  it('shapes the rows: rates, classes, and the slowest endpoints among those with enough requests', async () => {
    const { service } = makeService({
      rows: [
        [
          {
            requests: 200n,
            errors: 20n,
            client_errors: 15n,
            server_errors: 5n,
            avg_latency_ms: '80',
            avg_upstream_ms: '60',
            p50: 50,
            p95: 200,
            p99: 400,
            unique_clients: 7n,
            unique_keys: 2n,
            anonymous: 50n,
            bytes_in: 1024n,
            last_request_at: new Date('2026-09-19T10:00:00Z'),
          },
        ],
        [
          {
            bucket_epoch: 1_790_000_000n,
            requests: 200n,
            errors: 20n,
            avg_latency_ms: '80',
            p95: 200,
          },
        ],
        [
          { code: 200, count: 180n },
          { code: 404, count: 15n },
          { code: 500, count: 5n },
        ],
        [{ method: 'GET', count: 150n }],
        [
          { method: 'GET', path: '/a', requests: 100n, errors: 0n, avg_latency_ms: '10', p95: 20 },
          {
            method: 'GET',
            path: '/slow',
            requests: 6n,
            errors: 3n,
            avg_latency_ms: '900',
            p95: 1500,
          },
          {
            method: 'GET',
            path: '/rare',
            requests: 2n,
            errors: 0n,
            avg_latency_ms: '5000',
            p95: 9000,
          },
        ],
      ],
    });
    const out = await service.getTraffic('t1', query());
    expect(out.summary.errorRate).toBe(10);
    expect(out.summary.anonymousShare).toBe(25);
    expect(out.summary.requestsPerSecond).toBe(0);
    expect(out.statusClasses).toEqual([
      { class: '2xx', count: 180 },
      { class: '3xx', count: 0 },
      { class: '4xx', count: 15 },
      { class: '5xx', count: 5 },
    ]);
    expect(out.topEndpoints.map((e) => e.path)).toEqual(['/a', '/slow', '/rare']);
    expect(out.slowestEndpoints.map((e) => e.path)).toEqual(['/slow', '/a']);
    expect(out.slowestEndpoints[0]?.errorRate).toBe(50);
  });
});
