import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AnalyticsTrafficQueryDto } from '../dto/analytics-query.dto';
import type {
  AnalyticsTrafficResponse,
  TrafficEndpointResponse,
} from '../dto/analytics-response.dto';
import {
  analyticsWindow,
  errorRatePercent,
  MAX_TIME_SERIES_BUCKETS,
  round2,
  toNumber,
} from './pump-query.builder';
import {
  trafficEndpointQuery,
  trafficMethodQuery,
  trafficStatusQuery,
  trafficSummaryQuery,
  trafficTimeSeriesQuery,
  type TrafficBucketRow,
  type TrafficEndpointRow,
  type TrafficFilters,
  type TrafficMethodRow,
  type TrafficStatusRow,
  type TrafficSummaryRow,
} from './traffic-query.builder';

const TOP_N = 10;
/** An endpoint needs this many requests before its p95 is worth ranking. */
const MIN_REQUESTS_FOR_SLOWEST = 5;

const WINDOW_SECONDS = { '1h': 3600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000 } as const;

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;

/**
 * The filtered traffic view. Tenant scoping is the same as the rest of analytics — by the tenant's
 * own `tykApiId` set — and the `apiId` / `keyId` filters are resolved against the caller's tenant
 * first, so another tenant's id can only ever produce an empty result, never its data.
 */
@Injectable()
export class TrafficAnalyticsService {
  private readonly logger = new Logger(TrafficAnalyticsService.name);

  constructor(@Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient) {}

  async getTraffic(
    tenantId: string,
    query: AnalyticsTrafficQueryDto,
  ): Promise<AnalyticsTrafficResponse> {
    const window = analyticsWindow(query.range);
    const filters = await this.resolveFilters(tenantId, query);
    if (!filters) return this.empty(query.range);

    const [summary, buckets, statuses, methods, endpoints] = await Promise.all([
      this.safeQuery<TrafficSummaryRow>(trafficSummaryQuery(window, filters), 'traffic summary'),
      this.safeQuery<TrafficBucketRow>(
        trafficTimeSeriesQuery(window, filters, MAX_TIME_SERIES_BUCKETS),
        'traffic time series',
      ),
      this.safeQuery<TrafficStatusRow>(trafficStatusQuery(window, filters), 'traffic status codes'),
      this.safeQuery<TrafficMethodRow>(trafficMethodQuery(window, filters), 'traffic methods'),
      this.safeQuery<TrafficEndpointRow>(
        trafficEndpointQuery(window, filters),
        'traffic endpoints',
      ),
    ]);

    // `noUncheckedIndexedAccess` is off in this app, so say out loud that a no-row result is possible.
    const s = summary[0] as TrafficSummaryRow | undefined;
    const requests = toNumber(s?.requests);
    const windowSeconds = WINDOW_SECONDS[query.range];
    const endpointRows = endpoints.map((row): TrafficEndpointResponse => {
      const n = toNumber(row.requests);
      const errors = toNumber(row.errors);
      return {
        method: row.method,
        path: row.path,
        requests: n,
        errors,
        errorRate: errorRatePercent(errors, n),
        avgLatencyMs: round2(toNumber(row.avg_latency_ms)),
        p95LatencyMs: round2(toNumber(row.p95)),
      };
    });

    const byClass = new Map<string, number>();
    for (const row of statuses) {
      const cls = `${String(Math.floor(toNumber(row.code) / 100))}xx`;
      byClass.set(cls, (byClass.get(cls) ?? 0) + toNumber(row.count));
    }

    return {
      range: query.range,
      windowSeconds,
      summary: {
        requests,
        requestsPerSecond: round2(requests / windowSeconds),
        errors: toNumber(s?.errors),
        errorRate: errorRatePercent(toNumber(s?.errors), requests),
        clientErrors: toNumber(s?.client_errors),
        serverErrors: toNumber(s?.server_errors),
        avgLatencyMs: round2(toNumber(s?.avg_latency_ms)),
        avgUpstreamLatencyMs: round2(toNumber(s?.avg_upstream_ms)),
        p50LatencyMs: round2(toNumber(s?.p50)),
        p95LatencyMs: round2(toNumber(s?.p95)),
        p99LatencyMs: round2(toNumber(s?.p99)),
        uniqueClients: toNumber(s?.unique_clients),
        uniqueKeys: toNumber(s?.unique_keys),
        anonymousShare: requests > 0 ? round2((toNumber(s?.anonymous) / requests) * 100) : 0,
        bytesIn: toNumber(s?.bytes_in),
        lastRequestAt: s?.last_request_at ? s.last_request_at.toISOString() : null,
      },
      timeseries: buckets.map((row) => ({
        bucket: new Date(toNumber(row.bucket_epoch) * 1000).toISOString(),
        requests: toNumber(row.requests),
        errors: toNumber(row.errors),
        avgLatencyMs: round2(toNumber(row.avg_latency_ms)),
        p95LatencyMs: round2(toNumber(row.p95)),
      })),
      statusClasses: STATUS_CLASSES.map((cls) => ({ class: cls, count: byClass.get(cls) ?? 0 })),
      statusCodes: statuses
        .slice(0, TOP_N)
        .map((row) => ({ code: toNumber(row.code), count: toNumber(row.count) })),
      methods: methods.map((row) => ({ method: row.method, count: toNumber(row.count) })),
      topEndpoints: endpointRows.slice(0, TOP_N),
      slowestEndpoints: endpointRows
        .filter((row) => row.requests >= MIN_REQUESTS_FOR_SLOWEST)
        .sort((a, b) => b.p95LatencyMs - a.p95LatencyMs)
        .slice(0, TOP_N),
    };
  }

  /** Null when the filters can match nothing: no synced API, or an API / key that is not this tenant's. */
  private async resolveFilters(
    tenantId: string,
    q: AnalyticsTrafficQueryDto,
  ): Promise<TrafficFilters | null> {
    let tykApiIds: string[];
    if (q.apiId) {
      const api = await this.prisma.apiDefinition.findFirst({
        where: { id: q.apiId, tenantId },
        select: { tykApiId: true },
      });
      if (!api?.tykApiId) return null;
      tykApiIds = [api.tykApiId];
    } else {
      const apis = await this.prisma.apiDefinition.findMany({
        where: { tenantId, tykApiId: { not: null } },
        select: { tykApiId: true },
      });
      tykApiIds = apis.map((a) => a.tykApiId).filter((id): id is string => id !== null);
      if (tykApiIds.length === 0) return null;
    }

    let keyHash: string | undefined;
    if (q.keyId) {
      const key = await this.prisma.apiKey.findFirst({
        where: { id: q.keyId, tenantId },
        select: { tykKeyId: true },
      });
      if (!key?.tykKeyId) return null;
      keyHash = key.tykKeyId;
    }

    return {
      tykApiIds,
      keyHash,
      method: q.method,
      statusClass: q.statusClass,
      status: q.status,
      path: q.path?.trim() ? q.path.trim() : undefined,
      minLatencyMs: q.minLatencyMs,
      auth: q.auth,
    };
  }

  private empty(range: AnalyticsTrafficResponse['range']): AnalyticsTrafficResponse {
    return {
      range,
      windowSeconds: WINDOW_SECONDS[range],
      summary: {
        requests: 0,
        requestsPerSecond: 0,
        errors: 0,
        errorRate: 0,
        clientErrors: 0,
        serverErrors: 0,
        avgLatencyMs: 0,
        avgUpstreamLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        uniqueClients: 0,
        uniqueKeys: 0,
        anonymousShare: 0,
        bytesIn: 0,
        lastRequestAt: null,
      },
      timeseries: [],
      statusClasses: STATUS_CLASSES.map((cls) => ({ class: cls, count: 0 })),
      statusCodes: [],
      methods: [],
      topEndpoints: [],
      slowestEndpoints: [],
    };
  }

  /** The pump tables may not exist yet: degrade to empty rows, like the rest of analytics. */
  private async safeQuery<T>(sql: Prisma.Sql, label: string): Promise<T[]> {
    try {
      return await this.prisma.$queryRaw<T[]>(sql);
    } catch (err) {
      this.logger.warn(
        `Traffic query failed (${label}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
