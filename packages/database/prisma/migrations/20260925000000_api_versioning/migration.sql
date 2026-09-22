-- WP16 — API versioning. A child version is a full `api_definitions` row pointing back at its
-- family's default via `parent_api_id`; both carry `version_name`. Idempotent (safe to replay, safe
-- on a shadow DB).

-- 1. New status: a retired (non-default) version. Postgres 12+ supports IF NOT EXISTS directly on
--    ADD VALUE, so no DO-block existence check is needed here (unlike a brand new CREATE TYPE).
ALTER TYPE "ApiStatus" ADD VALUE IF NOT EXISTS 'RETIRED';

-- 2. Self-referential version family columns.
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "parent_api_id" TEXT;
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "version_name" TEXT;
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "retired_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "api_definitions_parent_api_id_idx" ON "api_definitions"("parent_api_id");

-- A family can't have two versions with the same name; NULLs (every non-version row) are distinct
-- from each other in Postgres, so this only constrains actual children.
CREATE UNIQUE INDEX IF NOT EXISTS "api_definitions_parent_api_id_version_name_key"
  ON "api_definitions"("parent_api_id", "version_name");

-- RESTRICT, not CASCADE: deleting the default while versions exist must answer 409
-- (ApiService.remove), never silently take the versions with it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_definitions_parent_api_id_fkey'
  ) THEN
    ALTER TABLE "api_definitions"
      ADD CONSTRAINT "api_definitions_parent_api_id_fkey"
      FOREIGN KEY ("parent_api_id") REFERENCES "api_definitions"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
