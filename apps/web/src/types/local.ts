// Local type definitions for the frontend
// These mirror the types from @open-gateway/types package

// ─── Auth / User ──────────────────────────────────────────────

export type UserRole = 'super_admin' | 'admin' | 'manager' | 'member' | 'viewer';
export type UserStatus = 'active' | 'inactive' | 'suspended' | 'pending_verification';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  tenantId: string;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `GET /auth/me` — the caller's roles and the permission names granted by them (`resource:action`). */
export interface AuthMe {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  tenants: { tenantId: string; role: string; name: string }[];
  /** Name of the user's default (else first) tenant; null when the user has none. */
  tenantName: string | null;
}

// ─── API Response Types ──────────────────────────────────────

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
  path: string;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: {
    requestId?: string;
    executionTime?: number;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: ApiError;
  meta?: {
    requestId?: string;
    executionTime?: number;
  };
}

/** List envelope exactly as the API sends it: `{ data, meta: { page, pageSize, totalCount, totalPages } }`. */
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

// ─── Status Enums ──────────────────────────────────────────────

export type ApiStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED';
export type ApiKeyStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';
export type ApiHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
export type TenantStatus = 'active' | 'suspended' | 'trial' | 'expired' | 'pending_setup';

export type AuditAction =
  | 'CREATED'
  | 'UPDATED'
  | 'DELETED'
  | 'REVOKED'
  | 'LOGIN'
  | 'LOGOUT'
  | 'ROLE_CHANGED'
  | 'SYNC_SUCCEEDED'
  | 'SYNC_FAILED';

// ─── API management ─────────────────────────────────────────────

export type ApiSyncStatus = 'PENDING' | 'SYNCED' | 'FAILED';

/** name/value pair, e.g. one header add or one mock response header. */
export interface ApiConfigHeader {
  name: string;
  value: string;
}

/**
 * `ApiDefinition.config` JSON (spec §3.2). Mirrors `apps/api/.../dto/api-config.dto.ts` field for
 * field — that DTO is the source of truth; this is a plain-data echo of its shape for the frontend,
 * kept in sync by hand since the two apps do not share a types package. `rateLimit.rate` 0 disables
 * the per-API limit. `null` on a nullable section clears it on PATCH; an absent key leaves it as-is
 * (section-level merge, `ApiService.update`).
 */
export interface ApiConfig {
  rateLimit?: { rate: number; per: number } | null;
  cors?: {
    enable: boolean;
    allowedOrigins: string[];
    allowedMethods: string[];
    allowedHeaders: string[];
    exposedHeaders: string[];
    allowCredentials: boolean;
    /** seconds */
    maxAge: number;
  } | null;
  doNotTrack?: boolean;
  jwt?: { jwksUrl: string; issuer: string; identityField?: string } | null;
  /** WP15a */
  throttle?: { retryLimit: number; intervalSeconds: number } | null;
  /** WP15a, seconds. The gateway answers 504 past this against the upstream. */
  timeoutSeconds?: number | null;
  /** WP15a */
  circuitBreaker?: { threshold: number; sampleSize: number; coolDownSeconds: number } | null;
  /** WP15a, bytes. Capped by the DTO at the edge's own body-limit constant. */
  requestSizeLimitBytes?: number | null;
  /** WP15a */
  loadBalancing?: { targets: { url: string; weight: number }[]; skipUnavailableHosts?: boolean } | null;
  /** WP15a, at most 10 probes. Computes the API's `healthStatus`. */
  uptimeTests?: { url: string; method?: string; timeoutSeconds?: number }[] | null;
  /** WP15b */
  transformRequestHeaders?: { add?: ApiConfigHeader[]; remove?: string[] } | null;
  /** WP15b */
  transformResponseHeaders?: { add?: ApiConfigHeader[]; remove?: string[] } | null;
  /** WP15b */
  urlRewrite?: { pattern: string; rewriteTo: string } | null;
  /** WP15b. When set, the upstream is never called. */
  mock?: { code: number; body: string; headers?: ApiConfigHeader[] } | null;
  /** WP15b */
  transformRequestBody?: { format: 'json' | 'xml'; body: string } | null;
  /** WP15b */
  transformResponseBody?: { format: 'json' | 'xml'; body: string } | null;
  /** WP15b */
  cache?: { timeoutSeconds: number; cacheAllSafeRequests?: boolean; cacheResponseCodes?: number[] } | null;
  /** WP15c, evaluated against the client IP (the edge replaces X-Forwarded-For, not appends to it). */
  ipAccessControl?: { allow?: string[]; block?: string[] } | null;
  /** WP15c. JSON Schema; a violating request body is rejected by the gateway with 422. */
  validateRequestSchema?: Record<string, unknown> | null;
  /** WP15c. Defaults to Authorization; setting this REPLACES that header rather than adding to it. */
  authHeaderName?: string;
  /**
   * WP15c. PARKED (worker-1, WP15c): mapper is written but no signing-string variant produced a
   * working 200 against Tyk OSS 5.15.0 — the Designer intentionally has no editable control for
   * this, only a disabled placeholder, so it never implies HMAC auth works end to end.
   */
  hmac?: { allowedAlgorithms?: string[]; allowedClockSkewMs?: number } | null;
  /** WP15b. Off by default and per-API on purpose — detailed records carry headers and bodies. */
  detailedRecording?: boolean;
  /** WP26a. Presents this certificate to the upstream when it demands a client certificate
   * (upstream mTLS, NOT client-certificate auth at the gateway — that is cut, O13). */
  upstreamMutualTls?: { certificateId: string } | null;
}

/**
 * The generated Tyk OAS document (`GET /apis/:id`, WP17). `paths` is empty unless per-operation
 * middleware is configured, in which case it holds one synthesised catch-all path (`/.*`) per
 * method — this product proxies whole upstreams rather than describing per-endpoint contracts, so
 * that already is the complete endpoint list until OAS import (WP24) lands.
 */
export interface OasDocument {
  paths?: Record<string, Record<string, { operationId?: string }>>;
  [key: string]: unknown;
}

// ─── Gateway status (`GET /gateway/status`, spec §5.2) ────────────

export interface GatewayStatus {
  gateway: {
    reachable: boolean;
    version: string | null;
    latencyMs: number | null;
    redis: 'pass' | 'fail' | 'unknown';
    error: string | null;
  };
  apis: { total: number; synced: number; pending: number; failed: number };
  /** At most 20 entries. */
  failedSyncs: {
    id: string;
    name: string;
    slug: string;
    syncError: string | null;
    lastSyncedAt: string | null;
  }[];
}

// ─── Settings (`GET /settings`, `/gateway/nodes/health`, `/gateway/reload`, WP14) ─

/** `GET /settings` — all read-only config, U17: no node CRUD, no secret rotation here or anywhere in the UI. */
export interface TenantSettings {
  tykOrgId: string;
  analyticsRetentionDays: number;
  analyticsAggregateRetentionDays: number;
}

/** One entry of `GET /gateway/nodes/health` — the `nodeUrl` is the admin URL (`/tyk` suffix); the UI labels nodes by position and never shows it. */
export interface NodeHealthEntry {
  nodeUrl: string;
  health: GatewayStatus['gateway'];
}

/** One entry of `POST /gateway/reload`'s per-node fan-out report. */
export interface GatewayReloadOutcome {
  nodeUrl: string;
  ok: boolean;
  data?: { latencyMs: number };
  error?: string;
}

// ─── Analytics (`/analytics/*`, spec §5.4) ────────────────────────

export type AnalyticsRange = '1h' | '24h' | '7d' | '30d';
export type AnalyticsMetric = 'requests' | 'errors' | 'latency';

/** `errorRate` fields below are percentages in the range 0-100. */
export interface AnalyticsOverview {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  avgUpstreamLatencyMs: number;
  /** Percentiles over per-request latency (ms). */
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  activeApis: number;
  activeKeys: number;
  range: AnalyticsRange;
  /** ISO timestamp */
  generatedAt: string;
}

/** Filters of `GET /analytics/traffic`; every field is optional and narrows the same window. */
export interface TrafficFilters {
  range: AnalyticsRange;
  apiId?: string;
  keyId?: string;
  method?: string;
  statusClass?: '2xx' | '3xx' | '4xx' | '5xx';
  status?: number;
  path?: string;
  minLatencyMs?: number;
  auth?: 'authenticated' | 'anonymous';
}

export interface TrafficEndpoint {
  method: string;
  path: string;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface AnalyticsTraffic {
  range: AnalyticsRange;
  windowSeconds: number;
  summary: {
    requests: number;
    requestsPerSecond: number;
    errors: number;
    errorRate: number;
    clientErrors: number;
    serverErrors: number;
    avgLatencyMs: number;
    avgUpstreamLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    uniqueClients: number;
    uniqueKeys: number;
    anonymousShare: number;
    bytesIn: number;
    lastRequestAt: string | null;
  };
  timeseries: { bucket: string; requests: number; errors: number; avgLatencyMs: number; p95LatencyMs: number }[];
  statusClasses: { class: '2xx' | '3xx' | '4xx' | '5xx'; count: number }[];
  statusCodes: { code: number; count: number }[];
  methods: { method: string; count: number }[];
  topEndpoints: TrafficEndpoint[];
  slowestEndpoints: TrafficEndpoint[];
}

export interface AnalyticsTimeSeriesPoint {
  /** ISO timestamp of the bucket start (minute for `1h`, hour for `24h`/`7d`, day for `30d`). */
  bucket: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface AnalyticsApiRow {
  apiDefId: string;
  name: string;
  slug: string;
  status: ApiStatus;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
}

export interface AnalyticsKeyRow {
  apiKeyId: string;
  name: string;
  status: ApiKeyStatus;
  apiDefName: string | null;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
}

export interface AnalyticsTopApi {
  rank: number;
  apiDefId: string;
  name: string;
  slug: string;
  requests: number;
}

export interface AnalyticsStatusCode {
  /** `'2xx'` or a specific/bucketed error code such as `'401'`, `'429'`, `'4xx'`, `'5xx'`. */
  code: string;
  count: number;
}

export interface AnalyticsHealth {
  /** Both pump tables exist AND the pump is alive. */
  pipelineReady: boolean;
  /** The pump's health endpoint answered; false = pump stopped/unreachable (existing data is stale). */
  pumpReachable: boolean;
  rawTablePresent: boolean;
  aggregateTablePresent: boolean;
  /** ISO timestamp of the newest raw record, or null when there is none. */
  lastRecordAt: string | null;
  rowCount: number;
}
