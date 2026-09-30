import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { RedisService } from '../../../common/redis/redis.service';
import { AnalyticsMetric, AnalyticsRange } from '../dto/analytics-query.dto';
import { AnalyticsService } from './analytics.service';
import type { PumpHealthService } from './pump-health.service';
import { ANALYTICS_INDEX_DDL, analyticsRedactionDdl } from './pump-query.builder';
import { AnalyticsRetentionScheduler } from './analytics-retention.scheduler';

const TENANT = 'tenant-1';

type QueryMock = jest.Mock<Promise<unknown[]>, [Prisma.Sql]>;
type ExecuteMock = jest.Mock<Promise<number>, [Prisma.Sql]>;
type FindManyMock = jest.Mock<Promise<unknown[]>, [unknown]>;
type CountMock = jest.Mock<Promise<number>, [unknown]>;

interface PrismaMock {
  apiDefinition: { findMany: FindManyMock; count: CountMock };
  apiKey: { findMany: FindManyMock; count: CountMock };
  $queryRaw: QueryMock;
  $queryRawUnsafe: jest.Mock<Promise<unknown>, [string]>;
  $executeRaw: ExecuteMock;
}

function makePrisma(): PrismaMock {
  return {
    apiDefinition: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    apiKey: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
    $queryRawUnsafe: jest.fn<Promise<unknown>, [string]>(),
    $executeRaw: jest.fn<Promise<number>, [Prisma.Sql]>(),
  };
}

interface RedisMock {
  get: jest.Mock<Promise<string | null>, [string]>;
  setex: jest.Mock<Promise<'OK' | null>, [string, number, string]>;
}

function makeRedis(): RedisMock {
  return {
    get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
    setex: jest.fn<Promise<'OK' | null>, [string, number, string]>().mockResolvedValue('OK'),
  };
}

/** The UTC epoch (bigint seconds) Postgres returns for a bucket start. */
function epoch(iso: string): bigint {
  return BigInt(new Date(iso).getTime() / 1000);
}

function makePump(reachable = true): { isReachable: jest.Mock<Promise<boolean>, []> } {
  return { isReachable: jest.fn<Promise<boolean>, []>().mockResolvedValue(reachable) };
}

function makeService(
  prisma: PrismaMock,
  redis: RedisMock,
  pump: { isReachable: jest.Mock<Promise<boolean>, []> } = makePump(),
  env: Record<string, string> = {},
): AnalyticsService {
  return new AnalyticsService(
    prisma as unknown as PrismaClient,
    redis as unknown as RedisService,
    pump as unknown as PumpHealthService,
    new ConfigService(env),
  );
}

/** Every `Prisma.Sql` handed to `$queryRaw`, flattened for substring assertions. */
function issuedSql(prisma: PrismaMock): { text: string; values: unknown[] }[] {
  return prisma.$queryRaw.mock.calls.map(([sql]) => ({
    text: sql.text.replace(/\s+/g, ' ').trim(),
    values: sql.values,
  }));
}

describe('AnalyticsService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let prisma: PrismaMock;
  let redis: RedisMock;
  let service: AnalyticsService;

  beforeEach(() => {
    prisma = makePrisma();
    redis = makeRedis();
    service = makeService(prisma, redis);
  });

  describe('tenant isolation', () => {
    it('short-circuits every pump read when the tenant has no synced API', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([]);
      prisma.apiKey.findMany.mockResolvedValue([]);
      prisma.apiDefinition.count.mockResolvedValue(0);
      prisma.apiKey.count.mockResolvedValue(0);

      const overview = await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);
      const series = await service.getTimeSeries(TENANT, AnalyticsMetric.REQUESTS, AnalyticsRange.ONE_DAY);
      const apis = await service.getApiMetrics(TENANT, AnalyticsRange.ONE_DAY);
      const keys = await service.getKeyMetrics(TENANT, AnalyticsRange.ONE_DAY);
      const codes = await service.getStatusCodes(TENANT, AnalyticsRange.ONE_DAY);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(overview).toMatchObject({ totalRequests: 0, errorCount: 0, errorRate: 0, avgLatencyMs: 0 });
      expect(series).toEqual([]);
      expect(apis).toEqual([]);
      expect(keys).toEqual([]);
      expect(codes).toEqual([]);
    });

    it('binds the tenant apiid array into every apiid-scoped query', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }, { tykApiId: 'api-b' }]);
      prisma.apiDefinition.count.mockResolvedValue(2);
      prisma.apiKey.count.mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.getOverview(TENANT, AnalyticsRange.SEVEN_DAYS);
      await service.getTimeSeries(TENANT, AnalyticsMetric.LATENCY, AnalyticsRange.SEVEN_DAYS);
      await service.getStatusCodes(TENANT, AnalyticsRange.SEVEN_DAYS);

      const queries = issuedSql(prisma);
      // overview (aggregate rollup + percentile, always-raw), time series, status codes
      expect(queries).toHaveLength(4);
      for (const query of queries) {
        expect(query.values).toContainEqual(['api-a', 'api-b']);
        expect(query.text).not.toContain('api-a');
      }
    });

    it('scopes the status-code breakdown by apiid and never by dimension=errors', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw.mockResolvedValue([
        { c2xx: 5n, c400: 0n, c401: 1n, c403: 0n, c404: 0n, c429: 0n, c4xx_other: 0n, c500: 2n, c502: 0n, c503: 0n, c504: 0n, c5xx_other: 0n },
      ]);

      const codes = await service.getStatusCodes(TENANT, AnalyticsRange.ONE_DAY);

      const [query] = issuedSql(prisma);
      expect(query.text).toContain("dimension = 'apiid'");
      expect(query.text).not.toContain('errors');
      expect(query.values).toContainEqual(['api-a']);
      expect(codes).toEqual([
        { code: '2xx', count: 5 },
        { code: '401', count: 1 },
        { code: '500', count: 2 },
      ]);
    });

    it('rolls keys up by the tenant key hashes and skips unauthenticated traffic', async () => {
      prisma.apiKey.findMany.mockResolvedValue([
        { id: 'key-1', name: 'live', status: 'ACTIVE', tykKeyId: 'hash-1', apiDef: { name: 'Orders' } },
        { id: 'key-2', name: 'unsynced', status: 'ACTIVE', tykKeyId: null, apiDef: null },
        { id: 'key-3', name: 'anon-looking', status: 'ACTIVE', tykKeyId: '00000000', apiDef: null },
      ]);
      prisma.$queryRaw.mockResolvedValue([
        { dimension_value: 'hash-1', requests: 8n, success: 5n, errors: 3n, avg_latency_ms: '16', avg_upstream_ms: '12' },
      ]);

      const rows = await service.getKeyMetrics(TENANT, AnalyticsRange.ONE_DAY);

      const [query] = issuedSql(prisma);
      expect(query.values[0]).toEqual(['hash-1']);
      expect(query.values).toContain('00000000');
      expect(rows[0]).toEqual({
        apiKeyId: 'key-1',
        name: 'live',
        status: 'ACTIVE',
        apiDefName: 'Orders',
        requests: 8,
        errors: 3,
        errorRate: 37.5,
        avgLatencyMs: 16,
      });
      expect(rows.map((row) => row.requests)).toEqual([8, 0, 0]);
    });
  });

  describe('getOverview', () => {
    beforeEach(() => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }, { tykApiId: 'api-b' }]);
      prisma.apiDefinition.count.mockResolvedValue(2);
      prisma.apiKey.count.mockResolvedValue(3);
    });

    it('totals counter_* columns and weights latency by hits, with errorRate as a percentage', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { dimension_value: 'api-a', requests: 8n, success: 5n, errors: 3n, avg_latency_ms: '10', avg_upstream_ms: '6' },
        { dimension_value: 'api-b', requests: 2n, success: 2n, errors: 0n, avg_latency_ms: '50', avg_upstream_ms: '40' },
      ]);

      const overview = await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);

      expect(overview).toMatchObject({
        totalRequests: 10,
        successCount: 7,
        errorCount: 3,
        errorRate: 30,
        // (10*8 + 50*2) / 10 — a plain average of the two rows would wrongly be 30
        avgLatencyMs: 18,
        avgUpstreamLatencyMs: 12.8,
        activeApis: 2,
        activeKeys: 3,
        range: '24h',
      });
    });

    it('caches for 60s and serves the cached payload without touching the pump', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);

      expect(redis.setex).toHaveBeenCalledWith(`analytics:${TENANT}:overview:24h`, 60, expect.any(String));

      const payload = redis.setex.mock.calls[0][2];
      redis.get.mockResolvedValue(payload);
      prisma.$queryRaw.mockClear();

      const cached = await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(cached).toEqual(JSON.parse(payload));
    });

    it('degrades to zeros when the pump tables are missing instead of failing the request', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('relation "tyk_aggregated" does not exist'));

      const overview = await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);

      expect(overview).toMatchObject({ totalRequests: 0, errorRate: 0, activeApis: 2, activeKeys: 3 });
    });
  });

  describe('getApiMetrics / getTopApis', () => {
    beforeEach(() => {
      prisma.apiDefinition.findMany.mockResolvedValue([
        { id: 'def-a', name: 'Orders', slug: 'orders', status: 'ACTIVE', tykApiId: 'api-a' },
        { id: 'def-b', name: 'Billing', slug: 'billing', status: 'ACTIVE', tykApiId: 'api-b' },
        { id: 'def-c', name: 'Draft', slug: 'draft', status: 'DRAFT', tykApiId: null },
      ]);
      prisma.$queryRaw.mockResolvedValue([
        { dimension_value: 'api-b', requests: 12n, success: 12n, errors: 0n, avg_latency_ms: '5', avg_upstream_ms: '3' },
        { dimension_value: 'api-a', requests: 4n, success: 3n, errors: 1n, avg_latency_ms: '9', avg_upstream_ms: '7' },
      ]);
    });

    it('zero-fills APIs with no traffic and orders by request count', async () => {
      const rows = await service.getApiMetrics(TENANT, AnalyticsRange.ONE_DAY);

      expect(rows.map((row) => [row.slug, row.requests])).toEqual([
        ['billing', 12],
        ['orders', 4],
        ['draft', 0],
      ]);
      expect(rows[1]).toMatchObject({ errors: 1, errorRate: 25, avgLatencyMs: 9 });
      // an unsynced API has no tykApiId and must not borrow another API's rollup row
      expect(rows[2]).toMatchObject({ apiDefId: 'def-c', requests: 0, errorRate: 0 });
    });

    it('ranks the top APIs, honouring the caller limit, and caches the result', async () => {
      const top = await service.getTopApis(TENANT, AnalyticsRange.ONE_DAY, 2);

      expect(top).toEqual([
        { rank: 1, apiDefId: 'def-b', name: 'Billing', slug: 'billing', requests: 12 },
        { rank: 2, apiDefId: 'def-a', name: 'Orders', slug: 'orders', requests: 4 },
      ]);
      expect(redis.setex).toHaveBeenCalledWith(`analytics:${TENANT}:top-apis:2:24h`, 60, expect.any(String));
    });
  });

  describe('range 1h reads the raw table with the exact window start', () => {
    // 14:37:30 -> the 1h window opens at 13:37:30, NOT at the 13:00 hour bucket
    const FROM = new Date('2026-09-19T13:37:30.000Z');
    const FLOORED_EPOCH = Date.parse('2026-09-19T13:00:00.000Z') / 1000;

    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-09-19T14:37:30.000Z'), doNotFake: ['nextTick', 'queueMicrotask'] });
      prisma.apiDefinition.findMany.mockResolvedValue([
        { id: 'def-a', name: 'Orders', slug: 'orders', status: 'ACTIVE', tykApiId: 'api-a' },
      ]);
      prisma.apiDefinition.count.mockResolvedValue(1);
      prisma.apiKey.count.mockResolvedValue(1);
      prisma.apiKey.findMany.mockResolvedValue([
        { id: 'key-1', name: 'live', status: 'ACTIVE', tykKeyId: 'hash-1', apiDef: null },
      ]);
      prisma.$queryRaw.mockResolvedValue([]);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sums the overview from tyk_analytics with the same exact bound the 1h chart uses', async () => {
      await service.getOverview(TENANT, AnalyticsRange.ONE_HOUR);
      await service.getTimeSeries(TENANT, AnalyticsMetric.REQUESTS, AnalyticsRange.ONE_HOUR);

      // getOverview now issues 2 queries (rollup, percentile — always raw), then getTimeSeries 1 more.
      const [overview, percentile, chart] = issuedSql(prisma);
      expect(overview.text).toContain('FROM public.tyk_analytics');
      expect(overview.values).toEqual([['api-a'], FROM]);
      expect(overview.values).not.toContain(FLOORED_EPOCH);
      expect(percentile.text).toContain('percentile_cont');
      expect(percentile.text).toContain('FROM public.tyk_analytics');
      // same source table and same lower bound as the chart, so the totals cannot disagree with it
      expect(chart.text).toContain('FROM public.tyk_analytics');
      expect(chart.values).toContainEqual(FROM);
    });

    it.each([
      ['apis', (svc: AnalyticsService) => svc.getApiMetrics(TENANT, AnalyticsRange.ONE_HOUR)],
      ['keys', (svc: AnalyticsService) => svc.getKeyMetrics(TENANT, AnalyticsRange.ONE_HOUR)],
      ['status codes', (svc: AnalyticsService) => svc.getStatusCodes(TENANT, AnalyticsRange.ONE_HOUR)],
    ])('reads the %s breakdown from the raw table too', async (_label, call) => {
      await call(service);

      const [query] = issuedSql(prisma);
      expect(query.text).toContain('FROM public.tyk_analytics');
      expect(query.text).not.toContain('tyk_aggregated');
      expect(query.values).toContainEqual(FROM);
      expect(query.values).not.toContain(FLOORED_EPOCH);
    });

    it('keeps the hour-floored aggregate path for 24h, 7d and 30d (percentiles stay on the raw table)', async () => {
      await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);
      await service.getOverview(TENANT, AnalyticsRange.SEVEN_DAYS);
      await service.getOverview(TENANT, AnalyticsRange.THIRTY_DAYS);

      // Each getOverview issues 2 queries: the rollup (aggregate, hour-floored) and the percentile
      // (always raw, exact bound — percentile_cont has no meaning over tyk_aggregated's pre-summed
      // counters, see percentileLatencyQuery's comment).
      const queries = issuedSql(prisma);
      expect(queries).toHaveLength(6);
      const [rollups, percentiles] = [queries.filter((_, i) => i % 2 === 0), queries.filter((_, i) => i % 2 === 1)];

      for (const query of rollups) {
        expect(query.text).toContain('FROM public.tyk_aggregated');
        // bound epoch is on an hour boundary (aggregate rows are bucketed hourly)
        expect(query.values[1]).toEqual(expect.any(Number));
        expect((query.values[1] as number) % 3600).toBe(0);
      }
      for (const query of percentiles) {
        expect(query.text).toContain('FROM public.tyk_analytics');
        expect(query.text).toContain('percentile_cont');
      }
    });

    it('weights the raw-path average latency by requests across APIs', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }, { tykApiId: 'api-b' }]);
      prisma.$queryRaw.mockResolvedValue([
        { dimension_value: 'api-a', requests: 8n, success: 5n, errors: 3n, avg_latency_ms: '10', avg_upstream_ms: '6' },
        { dimension_value: 'api-b', requests: 2n, success: 2n, errors: 0n, avg_latency_ms: '50', avg_upstream_ms: '40' },
      ]);

      const overview = await service.getOverview(TENANT, AnalyticsRange.ONE_HOUR);

      expect(overview).toMatchObject({ totalRequests: 10, errorCount: 3, errorRate: 30, avgLatencyMs: 18 });
    });
  });

  describe('bounded lists (/analytics/apis, /analytics/keys, top-apis)', () => {
    const manyApis = Array.from({ length: 120 }, (_, index) => ({
      id: `def-${String(index)}`,
      name: `api-${String(index).padStart(3, '0')}`,
      slug: `api-${String(index)}`,
      status: 'ACTIVE',
      tykApiId: `tyk-${String(index)}`,
    }));

    it('caps the per-API rollup in SQL, busiest first, and returns at most `limit` rows', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue(manyApis);
      prisma.$queryRaw.mockResolvedValue([
        { dimension_value: 'tyk-7', requests: 9n, success: 9n, errors: 0n, avg_latency_ms: '1', avg_upstream_ms: '1' },
      ]);

      const rows = await service.getApiMetrics(TENANT, AnalyticsRange.ONE_DAY, 100);

      const [query] = issuedSql(prisma);
      expect(query.text).toMatch(/ORDER BY requests DESC, dimension_value LIMIT \$3$/);
      expect(query.values[2]).toBe(100);
      expect(rows).toHaveLength(100);
      expect(rows[0]).toMatchObject({ apiDefId: 'def-7', requests: 9 });
    });

    it('defaults to 50 rows for both lists when no limit is given', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue(manyApis);
      prisma.apiKey.findMany.mockResolvedValue(
        Array.from({ length: 80 }, (_, index) => ({
          id: `key-${String(index)}`,
          name: `key-${String(index).padStart(3, '0')}`,
          status: 'ACTIVE',
          tykKeyId: `hash-${String(index)}`,
          apiDef: null,
        })),
      );
      prisma.$queryRaw.mockResolvedValue([]);

      const apis = await service.getApiMetrics(TENANT, AnalyticsRange.ONE_DAY);
      const keys = await service.getKeyMetrics(TENANT, AnalyticsRange.ONE_DAY);

      expect(apis).toHaveLength(50);
      expect(keys).toHaveLength(50);
      const [apiQuery, keyQuery] = issuedSql(prisma);
      expect(apiQuery.values.at(-1)).toBe(50);
      expect(keyQuery.values.at(-1)).toBe(50);
      expect(keyQuery.text).toMatch(/ORDER BY requests DESC, dimension_value LIMIT \$4$/);
    });

    it('never limits the overview rollup, whose totals must cover every API', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue(manyApis);
      prisma.apiDefinition.count.mockResolvedValue(120);
      prisma.apiKey.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.getOverview(TENANT, AnalyticsRange.ONE_DAY);

      expect(issuedSql(prisma)[0].text).not.toContain('LIMIT');
    });

    it('caps top-apis by its own limit through the same SQL cap', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue(manyApis);
      prisma.$queryRaw.mockResolvedValue([]);

      const top = await service.getTopApis(TENANT, AnalyticsRange.ONE_DAY, 3);

      expect(top.map((row) => row.rank)).toEqual([1, 2, 3]);
      expect(issuedSql(prisma)[0].values.at(-1)).toBe(3);
    });
  });

  describe('getTimeSeries', () => {
    it('returns ISO buckets with all three series regardless of the requested metric', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw.mockResolvedValue([
        { bucket_epoch: epoch('2026-09-19T13:00:00.000Z'), requests: 6n, errors: 1n, avg_latency_ms: '12.345' },
      ]);

      const series = await service.getTimeSeries(TENANT, AnalyticsMetric.ERRORS, AnalyticsRange.ONE_DAY);

      expect(series).toEqual([
        { bucket: '2026-09-19T13:00:00.000Z', requests: 6, errors: 1, avgLatencyMs: 12.35 },
      ]);
    });

    it('turns the UTC bucket epoch into an ISO UTC instant, whatever shape the driver returns', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw.mockResolvedValue([
        // a UTC-midnight day bucket (30d) as bigint, then a minute bucket as a string and as a number
        { bucket_epoch: epoch('2026-09-18T00:00:00.000Z'), requests: 1n, errors: 0n, avg_latency_ms: null },
        { bucket_epoch: String(epoch('2026-09-18T23:59:00.000Z')), requests: 2n, errors: 0n, avg_latency_ms: '4' },
        { bucket_epoch: Number(epoch('2026-09-19T00:01:00.000Z')), requests: 3n, errors: 1n, avg_latency_ms: '6' },
      ]);

      const series = await service.getTimeSeries(TENANT, AnalyticsMetric.REQUESTS, AnalyticsRange.THIRTY_DAYS);

      expect(series.map((point) => point.bucket)).toEqual([
        '2026-09-18T00:00:00.000Z',
        '2026-09-18T23:59:00.000Z',
        '2026-09-19T00:01:00.000Z',
      ]);
      expect(series[0].avgLatencyMs).toBe(0);
    });

    it('reads the raw table for the 1h range and the aggregate table otherwise', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.getTimeSeries(TENANT, AnalyticsMetric.REQUESTS, AnalyticsRange.ONE_HOUR);
      await service.getTimeSeries(TENANT, AnalyticsMetric.REQUESTS, AnalyticsRange.THIRTY_DAYS);

      const [raw, aggregate] = issuedSql(prisma);
      expect(raw.text).toContain('FROM public.tyk_analytics');
      expect(raw.values).toContain('minute');
      expect(aggregate.text).toContain('FROM public.tyk_aggregated');
      expect(aggregate.values).toContain('day');
    });
  });

  describe('streamExportCsv', () => {
    function makeRes(): { write: jest.Mock; end: jest.Mock; chunks: string[] } {
      const chunks: string[] = [];
      return {
        chunks,
        write: jest.fn((chunk: string) => {
          chunks.push(chunk);
          return true;
        }),
        end: jest.fn(),
      };
    }

    it('writes the header even with nothing to export, and never buffers into one string', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([]);
      const res = makeRes();

      await service.streamExportCsv(TENANT, AnalyticsRange.ONE_DAY, res as never);

      expect(res.chunks).toEqual([
        '"Timestamp","API ID","API","Method","Path","Status","Latency (ms)"\r\n',
      ]);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('streams rows page by page, redacted-at-insert columns excluded, and stops on a short page', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      const row = {
        ts: new Date('2026-09-01T00:00:00.000Z'),
        apiid: 'api-a',
        api_name: 'Orders',
        method: 'GET',
        path: '/orders',
        responsecode: 200n,
        latency_total: 42n,
      };
      prisma.$queryRaw.mockResolvedValueOnce([row]); // shorter than the batch size: one page only
      const res = makeRes();

      await service.streamExportCsv(TENANT, AnalyticsRange.ONE_DAY, res as never);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // no second page fetched
      expect(res.chunks[1]).toContain('"2026-09-01T00:00:00.000Z","api-a","Orders","GET","/orders","200","42"');
      expect(res.chunks[0]).not.toContain('rawrequest');
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('writes exactly as many values per row as the header has columns (they were once shifted)', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          ts: new Date('2026-09-01T00:00:00.000Z'),
          apiid: 'api-a',
          api_name: 'Orders',
          method: 'GET',
          path: '/orders',
          responsecode: 200n,
          latency_total: 42n,
        },
      ]);
      const res = makeRes();

      await service.streamExportCsv(TENANT, AnalyticsRange.ONE_DAY, res as never);

      // None of these values contain a comma, so splitting on it counts columns.
      const columns = (line: string) => line.trim().split(',').length;
      expect(columns(res.chunks[1])).toBe(columns(res.chunks[0]));
    });
  });

  describe('getHealth', () => {
    it('reports both tables missing without querying them', async () => {
      prisma.$queryRaw.mockResolvedValue([{ raw_present: false, aggregate_present: false }]);

      const health = await service.getHealth(TENANT);

      expect(health).toEqual({
        pipelineReady: false,
        pumpReachable: true,
        rawTablePresent: false,
        aggregateTablePresent: false,
        lastRecordAt: null,
        rowCount: 0,
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('reports tenant-scoped freshness once the pipeline exists', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ raw_present: true, aggregate_present: true }])
        .mockResolvedValueOnce([{ row_count: 42n, last_record_at: new Date('2026-09-19T13:58:48.907Z') }]);

      const health = await service.getHealth(TENANT);

      expect(health).toEqual({
        pipelineReady: true,
        pumpReachable: true,
        rawTablePresent: true,
        aggregateTablePresent: true,
        lastRecordAt: '2026-09-19T13:58:48.907Z',
        rowCount: 42,
      });
      expect(issuedSql(prisma)[1].values).toEqual([['api-a']]);
    });

    it('is not ready when the pump is down even though both tables hold data, and keeps the stale stats', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ raw_present: true, aggregate_present: true }])
        .mockResolvedValueOnce([{ row_count: 42n, last_record_at: new Date('2026-09-19T13:58:48.907Z') }]);

      const health = await makeService(prisma, redis, makePump(false)).getHealth(TENANT);

      expect(health).toEqual({
        pipelineReady: false,
        pumpReachable: false,
        rawTablePresent: true,
        aggregateTablePresent: true,
        lastRecordAt: '2026-09-19T13:58:48.907Z',
        rowCount: 42,
      });
    });

    it('never treats an idle gateway (old rows, live pump) as degraded', async () => {
      prisma.apiDefinition.findMany.mockResolvedValue([{ tykApiId: 'api-a' }]);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ raw_present: true, aggregate_present: true }])
        .mockResolvedValueOnce([{ row_count: 1n, last_record_at: new Date('2020-01-01T00:00:00.000Z') }]);

      const health = await service.getHealth(TENANT);

      expect(health).toMatchObject({ pipelineReady: true, pumpReachable: true });
    });
  });

  describe('onModuleInit', () => {
    it('runs the index DDL constant once, as-is, at boot', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.onModuleInit();

      // Two DDL statements now: the index constant, then the redaction trigger (WP21).
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
      expect(prisma.$queryRawUnsafe).toHaveBeenNthCalledWith(1, ANALYTICS_INDEX_DDL);
      const redactionDdl = prisma.$queryRawUnsafe.mock.calls[1][0];
      expect(redactionDdl).toContain('og_redact_tyk_analytics_trg');
      expect(redactionDdl).toContain('password'); // a default field, when ANALYTICS_REDACT_FIELDS is unset
    });

    it('reads ANALYTICS_REDACT_FIELDS for the trigger body, dropping anything not a bare identifier', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      const withFields = makeService(prisma, makeRedis(), makePump(), {
        ANALYTICS_REDACT_FIELDS: 'ssn, my_field, "; DROP TABLE users; --",also-bad',
      });

      await withFields.onModuleInit();

      const redactionDdl = prisma.$queryRawUnsafe.mock.calls[1][0];
      expect(redactionDdl).toContain('ssn|my_field');
      expect(redactionDdl).not.toContain('DROP TABLE');
      expect(redactionDdl).not.toContain('also-bad');
    });

    it('survives a failing DDL (missing privilege) and logs a warning instead of crashing boot', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.$queryRawUnsafe.mockRejectedValue(new Error('permission denied'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
      warn.mockRestore();
    });
  });
});

describe('AnalyticsRetentionScheduler', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let prisma: PrismaMock;

  function makeScheduler(env: Record<string, string> = {}): AnalyticsRetentionScheduler {
    return new AnalyticsRetentionScheduler(prisma as unknown as PrismaClient, new ConfigService(env));
  }

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('deletes with the configured windows, guarded by to_regclass', async () => {
    prisma.$queryRaw.mockResolvedValue([{ raw_present: true, aggregate_present: true }]);
    prisma.$executeRaw.mockResolvedValueOnce(7).mockResolvedValueOnce(2);

    const result = await makeScheduler({
      ANALYTICS_RETENTION_DAYS: '14',
      ANALYTICS_AGGREGATE_RETENTION_DAYS: '90',
    }).purgeExpiredAnalytics();

    expect(result).toEqual({ rawDeleted: 7, aggregateDeleted: 2 });
    // the raw table exists now, so re-attempt the indexes the API could not create at boot
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toContain('og_tyk_analytics_apiid_ts');
    const [raw, aggregate] = prisma.$executeRaw.mock.calls.map(([sql]) => sql);
    expect(raw.text).toContain('make_interval(days => $1::int)');
    expect(raw.values).toEqual([14]);
    expect(aggregate.text).toContain('EXTRACT(EPOCH FROM now() - make_interval(days => $1::int))::bigint');
    expect(aggregate.text).not.toContain('to_timestamp("timestamp")');
    expect(aggregate.values).toEqual([90]);
  });

  it('second chance at the redaction trigger too: the exported DDL, with the same field rule as boot', async () => {
    prisma.$queryRaw.mockResolvedValue([{ raw_present: true, aggregate_present: false }]);
    prisma.$executeRaw.mockResolvedValue(0);

    await makeScheduler({ ANALYTICS_REDACT_FIELDS: 'ssn, my_field, "; DROP TABLE users; --"' }).purgeExpiredAnalytics();

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRawUnsafe).toHaveBeenNthCalledWith(1, ANALYTICS_INDEX_DDL);
    expect(prisma.$queryRawUnsafe).toHaveBeenNthCalledWith(2, analyticsRedactionDdl(['ssn', 'my_field']));
  });

  it('a failing trigger install is logged as an error and retention still runs', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.$queryRaw.mockResolvedValue([{ raw_present: true, aggregate_present: true }]);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('permission denied'));
    prisma.$executeRaw.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const result = await makeScheduler().purgeExpiredAnalytics();

    expect(result).toEqual({ rawDeleted: 3, aggregateDeleted: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('redaction trigger: permission denied'));
    error.mockRestore();
  });

  it('falls back to 30/365 days when the env vars are absent or invalid', async () => {
    prisma.$queryRaw.mockResolvedValue([{ raw_present: true, aggregate_present: true }]);
    prisma.$executeRaw.mockResolvedValue(0);

    await makeScheduler({ ANALYTICS_RETENTION_DAYS: 'nonsense' }).purgeExpiredAnalytics();

    const [raw, aggregate] = prisma.$executeRaw.mock.calls.map(([sql]) => sql);
    expect(raw.values).toEqual([30]);
    expect(aggregate.values).toEqual([365]);
  });

  it('deletes nothing while the pump has not created its tables', async () => {
    prisma.$queryRaw.mockResolvedValue([{ raw_present: false, aggregate_present: false }]);

    const result = await makeScheduler().purgeExpiredAnalytics();

    expect(result).toEqual({ rawDeleted: 0, aggregateDeleted: 0 });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('swallows a purge failure so the cron keeps running', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset'));

    await expect(makeScheduler().handleRetention()).resolves.toBeUndefined();
  });
});
