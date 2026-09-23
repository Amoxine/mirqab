-- WP18: commercial plans, API products, and the key -> plan link.
--
-- HAND-WRITTEN, NOT THE GENERATED SQL, and the difference matters. `prisma migrate diff` emitted
-- two extra statements:
--
--     DROP TABLE "tyk_aggregated";
--     DROP TABLE "tyk_analytics";
--
-- Those are Pump-owned tables (schema.prisma's "do not re-add them" note). Prisma proposes dropping
-- them because they exist in the database and are deliberately absent from the datamodel, so every
-- diff against this schema will keep proposing it. Applying it would destroy the analytics history
-- — including the `tyk_aggregated` rows THIS work package's metering job reads. They are omitted
-- here on purpose. This is the DoD-OWNER 4 carve-out: the gate is "the diff names only those two
-- tables, nothing else", never a literal exit code 0.
--
-- Every statement is guarded so a repeat deploy and a shadow-DB replay are both no-ops.

-- ─── plans ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rate" INTEGER NOT NULL DEFAULT 0,
    "per" INTEGER NOT NULL DEFAULT 1,
    "quota_max" INTEGER NOT NULL DEFAULT -1,
    "quota_period" "QuotaPeriod" NOT NULL DEFAULT 'MONTHLY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "plans_tenant_id_idx" ON "plans"("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "plans_tenant_id_name_key" ON "plans"("tenant_id", "name");

-- ─── products ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "products" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "products_tenant_id_idx" ON "products"("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenant_id_slug_key" ON "products"("tenant_id", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenant_id_name_key" ON "products"("tenant_id", "name");

-- ─── product_apis (join) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "product_apis" (
    "product_id" TEXT NOT NULL,
    "api_def_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_apis_pkey" PRIMARY KEY ("product_id","api_def_id")
);

CREATE INDEX IF NOT EXISTS "product_apis_api_def_id_idx" ON "product_apis"("api_def_id");

-- ─── api_keys.plan_id ────────────────────────────────────────────────────────
-- Nullable with no backfill on purpose: a pre-WP18 key keeps its inline rate/quota and keeps
-- working. Assigning a plan is an explicit action, never a migration side effect.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "plan_id" TEXT;

CREATE INDEX IF NOT EXISTS "api_keys_plan_id_idx" ON "api_keys"("plan_id");

-- ─── foreign keys ────────────────────────────────────────────────────────────
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each one is guarded by a catalogue lookup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_tenant_id_fkey') THEN
    ALTER TABLE "plans" ADD CONSTRAINT "plans_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_tenant_id_fkey') THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_apis_product_id_fkey') THEN
    ALTER TABLE "product_apis" ADD CONSTRAINT "product_apis_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_apis_api_def_id_fkey') THEN
    ALTER TABLE "product_apis" ADD CONSTRAINT "product_apis_api_def_id_fkey"
      FOREIGN KEY ("api_def_id") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- SET NULL, not CASCADE: retiring a commercial plan must not delete the customer's live
  -- credentials. The key falls back to having no policy, which is recoverable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_plan_id_fkey') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_plan_id_fkey"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
