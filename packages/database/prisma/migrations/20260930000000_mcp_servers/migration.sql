-- WP28: MCP gateway admin.
--
-- Hand-written rather than generated, for the reason schema.prisma's tail comment gives: a bare
-- `prisma migrate dev` diffs against the live DB, sees Pump's unmodeled tyk_analytics/tyk_aggregated
-- as drift and offers to reset. Every statement below is guarded so a repeat deploy and a shadow-DB
-- replay are both no-ops.

CREATE TABLE IF NOT EXISTS "mcp_servers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_api_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "listen_path" TEXT NOT NULL,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "tyk_api_id" TEXT,
    "status" "ApiStatus" NOT NULL DEFAULT 'ACTIVE',
    "sync_status" "ApiSyncStatus" NOT NULL DEFAULT 'PENDING',
    "sync_error" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_tyk_api_id_key" ON "mcp_servers"("tyk_api_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_tenant_id_slug_key" ON "mcp_servers"("tenant_id", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_tenant_id_listen_path_key" ON "mcp_servers"("tenant_id", "listen_path");
CREATE INDEX IF NOT EXISTS "mcp_servers_tenant_id_idx" ON "mcp_servers"("tenant_id");
CREATE INDEX IF NOT EXISTS "mcp_servers_source_api_id_idx" ON "mcp_servers"("source_api_id");

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "mcp_server_id" TEXT;
CREATE INDEX IF NOT EXISTS "api_keys_mcp_server_id_idx" ON "api_keys"("mcp_server_id");

-- ADD CONSTRAINT has no IF NOT EXISTS, so each foreign key is added only when absent.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_tenant_id_fkey') THEN
        ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    -- RESTRICT: an MCP proxy whose paired source API is gone is not a degraded proxy, it is a
    -- definition the gateway refuses to load. Delete the proxy first.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_source_api_id_fkey') THEN
        ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_source_api_id_fkey"
            FOREIGN KEY ("source_api_id") REFERENCES "api_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    -- SET NULL, matching api_keys.plan_id: deleting an MCP server must not destroy live credentials.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_mcp_server_id_fkey') THEN
        ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_mcp_server_id_fkey"
            FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
