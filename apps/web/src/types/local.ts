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

/** `ApiDefinition.config` JSON (spec §3.2). `rateLimit.rate` 0 disables the per-API limit. */
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
  activeApis: number;
  activeKeys: number;
  range: AnalyticsRange;
  /** ISO timestamp */
  generatedAt: string;
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
