-- WP12c — per-tenant gateway keying. Two independent changes, both idempotent (safe to replay,
-- safe on a shadow DB).

-- 1. Tenant.tykOrgId — the tenant's Tyk organisation.
--    Added nullable, backfilled, then made NOT NULL, because the value is derived from each row's
--    own id and Postgres cannot express that as a column DEFAULT. The backfill expression must stay
--    identical to `tykOrgIdFor` in packages/database/src/index.ts.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "tyk_org_id" TEXT;
UPDATE "tenants" SET "tyk_org_id" = 'og-' || "id" WHERE "tyk_org_id" IS NULL;
ALTER TABLE "tenants" ALTER COLUMN "tyk_org_id" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_tyk_org_id_key" ON "tenants"("tyk_org_id");

-- 2. Listen-path uniqueness moves from global to per tenant (O10).
--    The global index (20260919120000_listen_path_global_unique) stopped two tenants fighting over
--    one gateway route. That job now belongs to the listen path itself: what reaches the gateway is
--    `/{tenant.slug}{listen_path}` and slugs are globally unique, so the paths cannot collide. The
--    global index only survives as a squatting vector, so it goes.
DROP INDEX IF EXISTS "api_definitions_listen_path_key";
CREATE UNIQUE INDEX IF NOT EXISTS "api_definitions_tenant_id_listen_path_key" ON "api_definitions"("tenant_id", "listen_path");
