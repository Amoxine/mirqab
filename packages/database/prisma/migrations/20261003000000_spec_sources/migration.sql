-- OAS-08: watch an API's OpenAPI document at a URL and keep what it serves as candidate versions.
--
-- Hand-written, like 20261002000000_api_specs and for the same reason (schema.prisma's tail comment:
-- Pump's unmodeled tyk_analytics / tyk_aggregated tables make a bare `migrate dev` offer a reset).
-- Nothing below touches those tables. Every statement is guarded so a repeat deploy and a shadow-DB
-- replay are both no-ops. Additive only: the previous application build keeps working.
--
-- `SPEC_UPDATE_DETECTED` is added like 20261001000000 (unqualified type name) and is NOT used in this
-- file: a value added by ALTER TYPE cannot be used inside the transaction that adds it.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SPEC_UPDATE_DETECTED';

-- CREATE TYPE has no IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SpecCandidateState') THEN
        CREATE TYPE "SpecCandidateState" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED', 'SUPERSEDED');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "api_spec_sources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_def_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "interval_minutes" INTEGER NOT NULL,
    "next_check_at" TIMESTAMP(3) NOT NULL,
    "last_checked_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_result" TEXT,
    "last_error_code" TEXT,
    "etag" TEXT,
    "last_modified" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_spec_sources_pkey" PRIMARY KEY ("id")
);

-- source_text is nullable: it is kept only while the candidate is PENDING.
CREATE TABLE IF NOT EXISTS "spec_candidates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_def_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "openapi_version" TEXT NOT NULL,
    "source_text" TEXT,
    "endpoint_count" INTEGER NOT NULL,
    "base_version_no" INTEGER NOT NULL,
    "diff_summary" JSONB NOT NULL,
    "findings" JSONB NOT NULL,
    "state" "SpecCandidateState" NOT NULL DEFAULT 'PENDING',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,

    CONSTRAINT "spec_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_spec_sources_api_def_id_key" ON "api_spec_sources"("api_def_id");
CREATE INDEX IF NOT EXISTS "api_spec_sources_enabled_next_check_at_idx" ON "api_spec_sources"("enabled", "next_check_at");
CREATE INDEX IF NOT EXISTS "api_spec_sources_tenant_id_idx" ON "api_spec_sources"("tenant_id");
-- Deliberately NOT unique: content A may come back after B and be proposed again (A -> B -> A).
CREATE INDEX IF NOT EXISTS "spec_candidates_api_def_id_content_hash_idx" ON "spec_candidates"("api_def_id", "content_hash");
CREATE INDEX IF NOT EXISTS "spec_candidates_tenant_id_state_idx" ON "spec_candidates"("tenant_id", "state");

-- ADD CONSTRAINT has no IF NOT EXISTS. CASCADE from both parents, like api_specs.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_spec_sources_tenant_id_fkey') THEN
        ALTER TABLE "api_spec_sources" ADD CONSTRAINT "api_spec_sources_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_spec_sources_api_def_id_fkey') THEN
        ALTER TABLE "api_spec_sources" ADD CONSTRAINT "api_spec_sources_api_def_id_fkey"
            FOREIGN KEY ("api_def_id") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spec_candidates_tenant_id_fkey') THEN
        ALTER TABLE "spec_candidates" ADD CONSTRAINT "spec_candidates_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spec_candidates_api_def_id_fkey') THEN
        ALTER TABLE "spec_candidates" ADD CONSTRAINT "spec_candidates_api_def_id_fkey"
            FOREIGN KEY ("api_def_id") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
