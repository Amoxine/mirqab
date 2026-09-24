import type { ApiKeyStatus, ApiStatus } from '@prisma/client';
import type { AnalyticsRange } from './analytics-query.dto';

/**
 * Analytics response contracts (spec §5.4). Mirrored by `apps/web/src/types/local.ts`.
 * Every `errorRate` is a **percentage in the range 0-100**, rounded to two decimals.
 */

export interface AnalyticsOverviewResponse {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  avgUpstreamLatencyMs: number;
  /** `percentile_cont` over raw per-request latency — see `percentileLatencyQuery`'s comment for why
   *  this always reads `tyk_analytics`, never `tyk_aggregated`, regardless of `range`. */
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  activeApis: number;
  activeKeys: number;
  range: AnalyticsRange;
  generatedAt: string;
}

export interface AnalyticsTimeSeriesPointResponse {
  /**
   * ISO UTC instant of the bucket start (minute for `1h`, hour for `24h`/`7d`, day for `30d`).
   * Buckets are cut on UTC boundaries (a `30d` day is a UTC day), independent of server and browser.
   */
  bucket: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface AnalyticsApiRowResponse {
  apiDefId: string;
  name: string;
  slug: string;
  status: ApiStatus;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
}

export interface AnalyticsKeyRowResponse {
  apiKeyId: string;
  name: string;
  status: ApiKeyStatus;
  apiDefName: string | null;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
}

export interface AnalyticsTopApiResponse {
  rank: number;
  apiDefId: string;
  name: string;
  slug: string;
  requests: number;
}

export interface AnalyticsStatusCodeResponse {
  /** `'2xx'`, or a specific/bucketed error code such as `'401'`, `'429'`, `'4xx'`, `'5xx'`. */
  code: string;
  count: number;
}

export interface AnalyticsHealthResponse {
  /** Both pump tables exist (the pump has purged at least once) AND the pump is alive. */
  pipelineReady: boolean;
  /** The pump's health endpoint answered. False when it is stopped, unreachable or `PUMP_HEALTH_URL` is unset. */
  pumpReachable: boolean;
  rawTablePresent: boolean;
  aggregateTablePresent: boolean;
  /** Newest raw record for **this tenant's** APIs, or null when there is none. */
  lastRecordAt: string | null;
  /** Raw rows for this tenant's APIs. */
  rowCount: number;
}
