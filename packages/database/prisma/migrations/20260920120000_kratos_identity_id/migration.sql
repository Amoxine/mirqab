-- WP2/WP5: the shadow mapping between a Kratos identity and this app's user row.
--
-- Kratos v26.2.0 generates identity ids and rejects a client-supplied one (verified:
-- `POST /admin/identities` with an `id` field answers 400 "unknown field \"id\""), so the two ids
-- cannot be made equal. Additive and nullable on purpose: every FK to users.id (api_keys.user_id,
-- audit_logs.user_id, user_tenants.user_id) is untouched, and rows migrate to Kratos one at a time.
--
-- Note this is NOT the token subject: Hydra's `sub` is users.id (the login/consent app resolves the
-- Kratos identity to this row and accepts the login challenge with users.id), which is why the
-- column stays nullable and nothing in the request path reads it.
--
-- Idempotent: safe to replay, shadow-DB included.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kratos_identity_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "users_kratos_identity_id_key" ON "users"("kratos_identity_id");
