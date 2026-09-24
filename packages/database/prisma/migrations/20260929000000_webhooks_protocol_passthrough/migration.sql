-- WP27 — webhooks / events / protocol passthrough. Idempotent (safe to replay, safe on a shadow
-- DB). Sorts after 20260928000000_portal_backend.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApiProtocol') THEN
    CREATE TYPE "ApiProtocol" AS ENUM ('HTTP', 'TCP');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookDeliveryStatus') THEN
    CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('SUCCESS', 'FAILED');
  END IF;
END
$$;

ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "protocol" "ApiProtocol" NOT NULL DEFAULT 'HTTP';
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "listen_port" INTEGER;
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "webhooks_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_id" TEXT NOT NULL,
    "receiver_url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" "WebhookDeliveryStatus" NOT NULL,
    "response_status" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_tenant_id_idx" ON "webhook_subscriptions"("tenant_id");
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_api_id_idx" ON "webhook_subscriptions"("api_id");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscription_id_idx" ON "webhook_deliveries"("subscription_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_subscriptions_tenant_id_fkey') THEN
    ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_subscriptions_api_id_fkey') THEN
    ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_api_id_fkey"
      FOREIGN KEY ("api_id") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_subscription_id_fkey') THEN
    ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
