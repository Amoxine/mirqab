import type { useTranslations } from 'next-intl';

/** Prisma `AuditAction` enum values (the API 500s on anything else); labels come from `analytics.auditLogs.actions.*`. */
export const AUDIT_ACTION_VALUES = [
  'CREATED',
  'UPDATED',
  'DELETED',
  'REVOKED',
  'ASSIGNED',
  'UNASSIGNED',
  'LOGIN',
  'LOGOUT',
  'ROLE_CHANGED',
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'QUOTA_EXCEEDED',
  'SYNC_SUCCEEDED',
  'SYNC_FAILED',
] as const;

// ponytail: `AuditLogEntry.action` is typed wider than this list (see use-audit.ts) since the API's
// enum can grow independently — an action outside it falls back to the raw value instead of a missing-key warning.
/** `t` is the `analytics` namespace translator. */
export function auditActionLabel(t: ReturnType<typeof useTranslations>, action: string): string {
  return (AUDIT_ACTION_VALUES as readonly string[]).includes(action) ? t(`auditLogs.actions.${action}`) : action;
}
