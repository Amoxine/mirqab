-- WP22 — portal backend: Developer/Application/Subscription. Idempotent (safe to replay, safe on a
-- shadow DB). Depends on "plans" and "products" (20260926000000_plans_products_org_quotas), so this
-- sorts after every existing migration rather than sharing a timestamp with one it needs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeveloperStatus') THEN
    CREATE TYPE "DeveloperStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus') THEN
    CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');
  END IF;
END
$$;

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "requires_approval" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "developers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kratos_identity_id" TEXT NOT NULL,
    "status" "DeveloperStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "applications" (
    "id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "subscriptions" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "tyk_key_id" TEXT,
    "key_hash" TEXT,
    "tyk_acl_policy_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "developers_kratos_identity_id_key" ON "developers"("kratos_identity_id");
CREATE INDEX IF NOT EXISTS "developers_tenant_id_idx" ON "developers"("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "developers_tenant_id_email_key" ON "developers"("tenant_id", "email");

CREATE INDEX IF NOT EXISTS "applications_developer_id_idx" ON "applications"("developer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "applications_developer_id_name_key" ON "applications"("developer_id", "name");

CREATE INDEX IF NOT EXISTS "subscriptions_application_id_idx" ON "subscriptions"("application_id");
CREATE INDEX IF NOT EXISTS "subscriptions_product_id_idx" ON "subscriptions"("product_id");
CREATE INDEX IF NOT EXISTS "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_application_id_product_id_key" ON "subscriptions"("application_id", "product_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'developers_tenant_id_fkey') THEN
    ALTER TABLE "developers" ADD CONSTRAINT "developers_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_developer_id_fkey') THEN
    ALTER TABLE "applications" ADD CONSTRAINT "applications_developer_id_fkey"
      FOREIGN KEY ("developer_id") REFERENCES "developers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_application_id_fkey') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_application_id_fkey"
      FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_product_id_fkey') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_id_fkey') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
