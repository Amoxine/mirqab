-- OAS-01: keep the OpenAPI document an API was imported from, and its endpoint index.
--
-- Hand-written, like the other migrations here, for the reason schema.prisma's tail comment gives: a
-- bare `prisma migrate dev` diffs against the live DB, sees Pump's unmodeled tyk_analytics /
-- tyk_aggregated as drift and offers to reset. Nothing below touches those tables. Every statement is
-- guarded so a repeat deploy and a shadow-DB replay are both no-ops. Additive only: no existing table
-- or column changes, so the previous application build keeps working against the new schema.

CREATE TABLE IF NOT EXISTS "api_specs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_def_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "openapi_version" TEXT NOT NULL,
    "source_text" TEXT NOT NULL,
    "endpoint_index" JSONB NOT NULL,
    "endpoint_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_specs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_specs_api_def_id_version_no_key" ON "api_specs"("api_def_id", "version_no");
CREATE INDEX IF NOT EXISTS "api_specs_tenant_id_api_def_id_idx" ON "api_specs"("tenant_id", "api_def_id");

-- ADD CONSTRAINT has no IF NOT EXISTS, so each foreign key is added only when absent. CASCADE from
-- both parents: a spec has no meaning without its API, and deleting a tenant removes everything it owns.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_specs_tenant_id_fkey') THEN
        ALTER TABLE "api_specs" ADD CONSTRAINT "api_specs_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_specs_api_def_id_fkey') THEN
        ALTER TABLE "api_specs" ADD CONSTRAINT "api_specs_api_def_id_fkey"
            FOREIGN KEY ("api_def_id") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
