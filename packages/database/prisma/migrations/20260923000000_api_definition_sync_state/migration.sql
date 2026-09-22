-- WP13a — per-node sync state for an API definition.
--
-- Nullable and additive: it sits beside `sync_status` (the scalar the UI still reads) rather than
-- replacing it. NULL means "never reconciled", which is exactly the state every pre-existing row is
-- in, so no backfill is needed or wanted.
--
-- Idempotent: safe to replay and safe on a shadow DB.
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "sync_state" JSONB;
