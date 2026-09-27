import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { RedisService } from '../../../common/redis/redis.service';
import { csvCell } from '../../../common/utils/csv';
import { AnalyticsMetric, AnalyticsRange, DEFAULT_LIST_LIMIT } from '../dto/analytics-query.dto';
import type {
  AnalyticsApiRowResponse,
  AnalyticsHealthResponse,
  AnalyticsKeyRowResponse,
  AnalyticsOverviewResponse,
  AnalyticsStatusCodeResponse,
  AnalyticsTimeSeriesPointResponse,
  AnalyticsTopApiResponse,
} from '../dto/analytics-response.dto';
import {
  ANALYTICS_INDEX_DDL,
  analyticsRedactionDdl,
  analyticsWindow,
  apiRollupQuery,
  errorRatePercent,
  exportRowsQuery,
  keyRollupQuery,
  percentileLatencyQuery,
  rawStatsQuery,
  redactFieldsFrom,
  round2,
  statusCodeQuery,
  tablePresenceQuery,
  timeSeriesQuery,
  toNumber,
  UNAUTHENTICATED_KEY_HASH,
  type AnalyticsWindow,
  type ExportRow,
  type PercentileRow,
  type RawStatsRow,
  type RollupRow,
  type StatusCodeRow,
  type TablePresenceRow,
  type TimeSeriesRow,
} from './pump-query.builder';
import { PumpHealthService } from './pump-health.service';

const CACHE_TTL_SECONDS = 60;

/** `streamExportCsv`: rows fetched (and written) per round trip, and the total cap across the export. */
const EXPORT_BATCH_SIZE = 1000;
export const ANALYTICS_EXPORT_MAX_ROWS = 50_000;

const EXPORT_CSV_HEADER = ['Timestamp', 'API', 'Method', 'Path', 'Status', 'Latency (ms)'];

/** Order of the status-code breakdown; `2xx` comes from `counter_success` (spec §0.7). */
const STATUS_CODE_ORDER: { code: string; column: keyof StatusCodeRow }[] = [
  { code: '2xx', column: 'c2xx' },
  { code: '400', column: 'c400' },
  { code: '401', column: 'c401' },
  { code: '403', column: 'c403' },
  { code: '404', column: 'c404' },
  { code: '429', column: 'c429' },
  { code: '4xx', column: 'c4xx_other' },
  { code: '500', column: 'c500' },
  { code: '502', column: 'c502' },
  { code: '503', column: 'c503' },
  { code: '504', column: 'c504' },
  { code: '5xx', column: 'c5xx_other' },
];

interface Totals {
  requests: number;
  success: number;
  errors: number;
  latencySum: number;
  upstreamSum: number;
}

/**
 * Analytics over the Tyk Pump tables. Every read is scoped to the caller's own Tyk API ids (D6) and
 * short-circuits to zeros when the tenant has no synced API, so no SQL runs for an empty tenant.
 *
 * The pump creates `tyk_analytics` / `tyk_aggregated` on its first purge, so a missing table is a
 * normal state: pump reads degrade to zeros with a warning instead of failing the request, which is
 * what lets the dashboard render an "analytics pipeline not receiving data" hint (spec C4).
 */
@Injectable()
export class AnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient,
    private readonly redisService: RedisService,
    private readonly pumpHealth: PumpHealthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * `tyk_analytics` ships with no index at all (D9). Created here rather than in a Prisma migration
   * because the pump may create the table after `migrate deploy` has run. The redaction trigger
   * (WP21) runs here for the same reason, plus its field list has to be read from config at boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.prisma.$queryRawUnsafe(ANALYTICS_INDEX_DDL);
      this.logger.log('Analytics indexes ensured on tyk_analytics (skipped if the table is absent)');
    } catch (err) {
      this.logger.warn(`Could not ensure analytics indexes: ${this.describe(err)}`);
    }

    try {
      // The retention scheduler re-runs this install with the same field rule (cold stack, D9).
      const fields = redactFieldsFrom(this.configService.get<string>('ANALYTICS_REDACT_FIELDS'));
      await this.prisma.$queryRawUnsafe(analyticsRedactionDdl(fields));
      this.logger.log(
        `Analytics redaction trigger ensured on tyk_analytics (${String(fields.length)} body field(s), skipped if the table is absent)`,
      );
    } catch (err) {
      this.logger.warn(`Could not ensure analytics redaction trigger: ${this.describe(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------

  async getOverview(tenantId: string, range: AnalyticsRange): Promise<AnalyticsOverviewResponse> {
    const cacheKey = this.cacheKey(tenantId, 'overview', range);
    const cached = await this.readCache<AnalyticsOverviewResponse>(cacheKey);
    if (cached) return cached;

    const window = analyticsWindow(range);
    const [activeApis, activeKeys, tykApiIds] = await Promise.all([
      this.prisma.apiDefinition.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.prisma.apiKey.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.resolveTykApiIds(tenantId),
    ]);

    const [totals, percentiles] = await Promise.all([
      this.loadApiRollup(tykApiIds, window).then((rows) => this.sumRollup(rows)),
      this.loadPercentiles(tykApiIds, window),
    ]);

    const result: AnalyticsOverviewResponse = {
      totalRequests: totals.requests,
      successCount: totals.success,
      errorCount: totals.errors,
      errorRate: errorRatePercent(totals.errors, totals.requests),
      avgLatencyMs: this.weightedAverage(totals.latencySum, totals.requests),
      avgUpstreamLatencyMs: this.weightedAverage(totals.upstreamSum, totals.requests),
      p50LatencyMs: percentiles.p50,
      p95LatencyMs: percentiles.p95,
      p99LatencyMs: percentiles.p99,
      activeApis,
      activeKeys,
      range,
      generatedAt: new Date().toISOString(),
    };

    await this.writeCache(cacheKey, result);
    return result;
  }

  /**
   * `metric` does not change the query — all three series are returned so the chart can switch
   * without a refetch (spec §5.4). It is part of the contract and of the cache key only.
   */
  async getTimeSeries(
    tenantId: string,
    metric: AnalyticsMetric,
    range: AnalyticsRange,
  ): Promise<AnalyticsTimeSeriesPointResponse[]> {
    const tykApiIds = await this.resolveTykApiIds(tenantId);
    if (tykApiIds.length === 0) return [];

    const window = analyticsWindow(range);
    const rows = await this.safeQuery<TimeSeriesRow>(
      timeSeriesQuery(window, tykApiIds),
      `time series (${metric}, ${range})`,
    );

    return rows.map((row) => ({
      // UTC epoch seconds -> ISO UTC instant (the SQL already cut the bucket on a UTC boundary)
      bucket: new Date(toNumber(row.bucket_epoch) * 1000).toISOString(),
      requests: toNumber(row.requests),
      errors: toNumber(row.errors),
      avgLatencyMs: round2(toNumber(row.avg_latency_ms)),
    }));
  }

  async getApiMetrics(
    tenantId: string,
    range: AnalyticsRange,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<AnalyticsApiRowResponse[]> {
    const apis = await this.prisma.apiDefinition.findMany({
      where: { tenantId },
      select: { id: true, name: true, slug: true, status: true, tykApiId: true },
    });

    const window = analyticsWindow(range);
    const tykApiIds = apis.map((api) => api.tykApiId).filter((id): id is string => id !== null);
    const rollup = this.indexRollup(await this.loadApiRollup(tykApiIds, window, limit));

    return apis
      .map((api) => {
        const row = api.tykApiId === null ? undefined : rollup.get(api.tykApiId);
        const requests = toNumber(row?.requests ?? 0);
        const errors = toNumber(row?.errors ?? 0);

        return {
          apiDefId: api.id,
          name: api.name,
          slug: api.slug,
          status: api.status,
          requests,
          errors,
          errorRate: errorRatePercent(errors, requests),
          avgLatencyMs: round2(toNumber(row?.avg_latency_ms ?? 0)),
        };
      })
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async getKeyMetrics(
    tenantId: string,
    range: AnalyticsRange,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<AnalyticsKeyRowResponse[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        status: true,
        tykKeyId: true,
        apiDef: { select: { name: true } },
      },
    });

    const hashes = keys
      .map((key) => key.tykKeyId)
      .filter((hash): hash is string => hash !== null && hash !== UNAUTHENTICATED_KEY_HASH);

    const window = analyticsWindow(range);
    const rollup =
      hashes.length === 0
        ? new Map<string, RollupRow>()
        : this.indexRollup(
            await this.safeQuery<RollupRow>(
              keyRollupQuery(window, hashes, limit),
              `key rollup (${range})`,
            ),
          );

    return keys
      .map((key) => {
        const row = key.tykKeyId === null ? undefined : rollup.get(key.tykKeyId);
        const requests = toNumber(row?.requests ?? 0);
        const errors = toNumber(row?.errors ?? 0);

        return {
          apiKeyId: key.id,
          name: key.name,
          status: key.status,
          apiDefName: key.apiDef?.name ?? null,
          requests,
          errors,
          errorRate: errorRatePercent(errors, requests),
          avgLatencyMs: round2(toNumber(row?.avg_latency_ms ?? 0)),
        };
      })
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async getTopApis(
    tenantId: string,
    range: AnalyticsRange,
    limit: number,
  ): Promise<AnalyticsTopApiResponse[]> {
    const cacheKey = this.cacheKey(tenantId, `top-apis:${String(limit)}`, range);
    const cached = await this.readCache<AnalyticsTopApiResponse[]>(cacheKey);
    if (cached) return cached;

    const rows = await this.getApiMetrics(tenantId, range, limit);
    const result = rows.map((row, index) => ({
      rank: index + 1,
      apiDefId: row.apiDefId,
      name: row.name,
      slug: row.slug,
      requests: row.requests,
    }));

    await this.writeCache(cacheKey, result);
    return result;
  }

  async getStatusCodes(
    tenantId: string,
    range: AnalyticsRange,
  ): Promise<AnalyticsStatusCodeResponse[]> {
    const tykApiIds = await this.resolveTykApiIds(tenantId);
    if (tykApiIds.length === 0) return [];

    const window = analyticsWindow(range);
    const rows = await this.safeQuery<StatusCodeRow>(
      statusCodeQuery(window, tykApiIds),
      `status codes (${range})`,
    );
    if (rows.length === 0) return [];
    const [row] = rows;

    return STATUS_CODE_ORDER.map(({ code, column }) => ({
      code,
      count: toNumber(row[column]),
    })).filter((entry) => entry.count > 0);
  }

  /**
   * `GET /analytics/export?format=csv`. Streams, never buffers the full CSV in memory: each page is
   * fetched and written to `res` before the next is read, so memory stays bounded by
   * `EXPORT_BATCH_SIZE` regardless of `range`. Capped at `ANALYTICS_EXPORT_MAX_ROWS` total, same
   * "a request, not a background job" reasoning as `AuditService.CSV_MAX_ROWS`.
   *
   * Only the columns the analytics UI already shows (timestamp, API, method, path, status, latency)
   * — never `rawrequest`/`rawresponse`: those are redacted at insert (WP21), but a bulk CSV of
   * request/response bodies is a bigger exposure than this export is for, regardless.
   */
  async streamExportCsv(tenantId: string, range: AnalyticsRange, res: Response): Promise<void> {
    const tykApiIds = await this.resolveTykApiIds(tenantId);
    const window = analyticsWindow(range);

    res.write(EXPORT_CSV_HEADER.map(csvCell).join(',') + '\r\n');

    let offset = 0;
    while (tykApiIds.length > 0 && offset < ANALYTICS_EXPORT_MAX_ROWS) {
      const limit = Math.min(EXPORT_BATCH_SIZE, ANALYTICS_EXPORT_MAX_ROWS - offset);
      const rows = await this.safeQuery<ExportRow>(
        exportRowsQuery(window.from, tykApiIds, limit, offset),
        `export (${range}, offset ${String(offset)})`,
      );
      if (rows.length === 0) break;

      const chunk = rows
        .map((row) =>
          [
            row.ts.toISOString(),
            row.apiid,
            row.api_name,
            row.method,
            row.path,
            String(toNumber(row.responsecode)),
            String(toNumber(row.latency_total)),
          ]
            .map(csvCell)
            .join(','),
        )
        .join('\r\n');
      res.write(chunk + '\r\n');

      offset += rows.length;
      if (rows.length < limit) break; // short page: no more rows
    }

    res.end();
  }

  async getHealth(tenantId: string): Promise<AnalyticsHealthResponse> {
    const [presence, pumpReachable] = await Promise.all([
      this.safeQuery<TablePresenceRow>(tablePresenceQuery(), 'table presence'),
      this.pumpHealth.isReachable(),
    ]);
    const rawTablePresent = presence[0]?.raw_present ?? false;
    const aggregateTablePresent = presence[0]?.aggregate_present ?? false;

    let lastRecordAt: string | null = null;
    let rowCount = 0;

    if (rawTablePresent) {
      const tykApiIds = await this.resolveTykApiIds(tenantId);
      if (tykApiIds.length > 0) {
        const stats = await this.safeQuery<RawStatsRow>(rawStatsQuery(tykApiIds), 'raw table stats');
        rowCount = toNumber(stats[0]?.row_count ?? 0);
        lastRecordAt = stats[0]?.last_record_at?.toISOString() ?? null;
      }
    }

    return {
      pipelineReady: rawTablePresent && aggregateTablePresent && pumpReachable,
      pumpReachable,
      rawTablePresent,
      aggregateTablePresent,
      lastRecordAt,
      rowCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Tenant scope (D6): the caller's synced Tyk API ids. Empty ⇒ callers must not issue pump SQL. */
  private async resolveTykApiIds(tenantId: string): Promise<string[]> {
    const apis = await this.prisma.apiDefinition.findMany({
      where: { tenantId, tykApiId: { not: null } },
      select: { tykApiId: true },
    });

    return apis.map((api) => api.tykApiId).filter((id): id is string => id !== null);
  }

  /**
   * No `limit` ⇒ every API (the overview totals need them all); `limit` ⇒ busiest N, cut in SQL.
   * Public (TypeScript has no package-private) because `AuditService.findRelatedTraffic` calls it
   * with a single tenant-owned `tykApiId` it resolved itself. The caller owns the tenant scoping:
   * this method only guards an empty id list, it does not check that the ids belong to anyone.
   */
  async loadApiRollup(
    tykApiIds: string[],
    window: AnalyticsWindow,
    limit?: number,
  ): Promise<RollupRow[]> {
    if (tykApiIds.length === 0) return [];

    return this.safeQuery<RollupRow>(
      apiRollupQuery(window, tykApiIds, limit),
      `api rollup (${window.range})`,
    );
  }

  /**
   * p50/p95/p99, always from the raw table (see `percentileLatencyQuery`'s comment). Empty scope
   * short-circuits to zeros, same as every other tenant-scoped read here.
   */
  private async loadPercentiles(
    tykApiIds: string[],
    window: AnalyticsWindow,
  ): Promise<{ p50: number; p95: number; p99: number }> {
    if (tykApiIds.length === 0) return { p50: 0, p95: 0, p99: 0 };

    const rows = await this.safeQuery<PercentileRow>(
      percentileLatencyQuery(tykApiIds, window.from),
      `percentiles (${window.range})`,
    );
    if (rows.length === 0) return { p50: 0, p95: 0, p99: 0 };
    const [row] = rows;

    return {
      p50: round2(toNumber(row.p50)),
      p95: round2(toNumber(row.p95)),
      p99: round2(toNumber(row.p99)),
    };
  }

  private indexRollup(rows: RollupRow[]): Map<string, RollupRow> {
    return new Map(rows.map((row) => [row.dimension_value, row]));
  }

  private sumRollup(rows: RollupRow[]): Totals {
    return rows.reduce(
      (totals, row) => {
        const requests = toNumber(row.requests);
        return {
          requests: totals.requests + requests,
          success: totals.success + toNumber(row.success),
          errors: totals.errors + toNumber(row.errors),
          // Re-weight the per-API averages by their own hit count, which reproduces
          // SUM(counter_total_latency)/SUM(counter_hits) across APIs.
          latencySum: totals.latencySum + toNumber(row.avg_latency_ms) * requests,
          upstreamSum: totals.upstreamSum + toNumber(row.avg_upstream_ms) * requests,
        };
      },
      { requests: 0, success: 0, errors: 0, latencySum: 0, upstreamSum: 0 },
    );
  }

  private weightedAverage(sum: number, requests: number): number {
    if (requests <= 0) return 0;
    return round2(sum / requests);
  }

  /**
   * Pump tables are absent until the pump's first purge, and are outside our schema control. A read
   * failure degrades to "no data" so the dashboard still renders (spec C4).
   */
  private async safeQuery<T>(sql: Prisma.Sql, label: string): Promise<T[]> {
    try {
      return await this.prisma.$queryRaw<T[]>(sql);
    } catch (err) {
      this.logger.warn(`Analytics query failed (${label}): ${this.describe(err)}`);
      return [];
    }
  }

  private cacheKey(tenantId: string, metric: string, range: string): string {
    return `analytics:${tenantId}:${metric}:${range}`;
  }

  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const cached = await this.redisService.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as T;
    } catch (err) {
      this.logger.warn(`Analytics cache read failed for ${key}: ${this.describe(err)}`);
      return null;
    }
  }

  private async writeCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redisService.setex(key, CACHE_TTL_SECONDS, JSON.stringify(value));
    } catch (err) {
      this.logger.warn(`Analytics cache write failed for ${key}: ${this.describe(err)}`);
    }
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
