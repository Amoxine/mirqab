// ---------------------------------------------------------------------------
// User & Request Context
// ---------------------------------------------------------------------------

/**
 * Roles seeded per tenant by packages/database/prisma/seed.ts. `UserTenant.role` is a plain text
 * column, so these are the seeded values (lowercase), not a Prisma enum.
 */
export type RoleType = 'super_admin' | 'admin' | 'operator' | 'viewer';

/** The one role that is allowed to act outside its own tenant. */
export const SUPER_ADMIN_ROLE = 'super_admin';

/**
 * `UserTenant.role` is free-form text, so role checks compare case-insensitively everywhere
 * (RolesGuard, PermissionsGuard, TenantService) rather than trusting the stored casing.
 */
export const isSuperAdmin = (roles: readonly string[]): boolean =>
  roles.some((role) => role.toLowerCase() === SUPER_ADMIN_ROLE);

export type UserStatusType =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'SUSPENDED'
  | 'PENDING_VERIFICATION';

export interface UserPayload {
  sub: string;
  email: string;
  /** Roles held in the ACTIVE tenant only — never the union across tenants (see AuthService). */
  roles: RoleType[];
  /** Absent when the user has no tenant membership (e.g. created through POST /auth/register). */
  tenantId?: string;
  status: UserStatusType;
  permissions?: string[];
}

export interface RequestContext {
  userId: string;
  tenantId: string;
  correlationId: string;
  ipAddress: string | undefined;
  userAgent: string | undefined;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  userId: string;
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  circuitState: CircuitState;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface CacheConfig {
  key?: string;
  ttl?: number;
  tenantScoped?: boolean;
}

// ---------------------------------------------------------------------------
// Response Envelope
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  message?: string;
}
