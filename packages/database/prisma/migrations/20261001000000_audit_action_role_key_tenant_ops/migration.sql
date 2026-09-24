-- WP19 — Roles CRUD, key rotate/usage-reset, tenant org-quota-by-id. `@Audit()`'s suffix is
-- contractually an AuditAction value (AuditLogInterceptor uppercases the part after the last colon
-- and casts it) — ROTATED and USAGE_RESET are new for this WP; QUOTA_UPDATED backs
-- `PATCH /tenants/:id/quota`.
--
-- ORG_UPDATED / ORG_RESET / KEY_RESET are added here too: WP18's OrgQuotaController has carried
-- `@Audit('quota:org_updated', ...)` / `quota:org_reset` / `quota:key_reset` since it landed, and
-- none of those three values existed in this enum — every one of those audit writes has been
-- silently failing (caught and logged by the interceptor, not surfaced). Same bug, same fix, same
-- migration touching this enum. Idempotent (safe to replay, safe on a shadow DB).

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROTATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USAGE_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'QUOTA_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'QUOTA_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ORG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ORG_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KEY_RESET';
