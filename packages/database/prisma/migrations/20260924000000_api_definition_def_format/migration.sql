-- WP13b — how an API definition is expressed on the gateway (CLASSIC vs OAS).
--
-- THE ORDER OF THE TWO ALTER COLUMN STATEMENTS IS THE POINT, not a style choice.
--
-- Step 1 adds the column with DEFAULT 'CLASSIC', so every row that already exists — every live,
-- working, classic-format API — is labelled CLASSIC. Step 2 then flips the default to 'OAS' so
-- rows created from here on are OAS.
--
-- Collapsing these into one `ADD COLUMN ... DEFAULT 'OAS'` would label every pre-existing classic
-- API as OAS while the gateway still serves it from a classic definition. Nothing would fail: the
-- APIs keep working, the tests keep passing, and the database quietly lies about every one of them
-- until something re-syncs and pushes the wrong shape. That is a silent data-correctness bug, which
-- is why this is two statements.
--
-- `migrate diff --exit-code` still matches `@default(OAS)` in schema.prisma after step 2.
-- Idempotent: safe to replay and safe on a shadow DB.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApiDefFormat') THEN
    CREATE TYPE "ApiDefFormat" AS ENUM ('CLASSIC', 'OAS');
  END IF;
END
$$;

-- 1. existing rows are CLASSIC, because that is what the gateway is actually serving for them
ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "def_format" "ApiDefFormat" NOT NULL DEFAULT 'CLASSIC';

-- 2. and only now does the default become OAS, for rows created after this migration
ALTER TABLE "api_definitions" ALTER COLUMN "def_format" SET DEFAULT 'OAS';

ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "oas_document" JSONB;
