-- B1: a listen path must be unique across the whole gateway, not just within a tenant.
-- Tyk routes on the listen path alone, so two tenants claiming the same path fight over one route
-- (the gateway drops one of the duplicates on reload). Idempotent: safe to replay.
CREATE UNIQUE INDEX IF NOT EXISTS "api_definitions_listen_path_key" ON "api_definitions"("listen_path");
