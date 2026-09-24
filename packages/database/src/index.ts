export { Prisma, PrismaClient } from '@prisma/client';
export { prisma } from './prisma';

/**
 * A tenant's Tyk organisation id, derived from its row id. Called once, at tenant creation — the
 * value is then stored in `Tenant.tykOrgId` and read from there, never recomputed, so renaming a
 * tenant cannot orphan the gateway state stamped with it.
 *
 * The `20260922...` migration backfills existing rows with the same expression (`'og-' || id`);
 * keep the two in step if this ever changes.
 */
export const tykOrgIdFor = (tenantId: string): string => `og-${tenantId}`;
export type {
  User,
  Tenant,
  UserTenant,
  Role,
  Permission,
  RolePermission,
  ApiDefinition,
  ApiKey,
  Quota,
  AuditLog,
  UserStatus,
  TenantStatus,
  TenantPlan,
  ApiStatus,
  ApiSyncStatus,
  ApiHealthStatus,
  ApiAuthType,
  ApiDefFormat,
  ApiKeyStatus,
  QuotaPeriod,
  AuditAction,
} from '@prisma/client';
