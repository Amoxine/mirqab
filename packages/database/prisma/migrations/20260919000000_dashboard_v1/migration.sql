-- Dashboard v1: surface why an API sync failed and when it last succeeded.
-- Idempotent: safe to replay.
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "sync_error" TEXT;
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP(3);
