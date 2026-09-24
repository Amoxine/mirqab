-- WP15c — two more ways an API can authenticate its callers.
--
-- ADD VALUE, never DROP + recreate. Dropping and recreating an enum would rewrite every
-- `api_definitions.auth_type` in the process and break the FK-like references to it; adding is
-- non-destructive and leaves existing rows untouched.
--
-- `IF NOT EXISTS` makes it replayable. Postgres 16 permits ADD VALUE inside a transaction as long
-- as the new value is not USED in the same transaction, which nothing here does.
ALTER TYPE "ApiAuthType" ADD VALUE IF NOT EXISTS 'HMAC';
ALTER TYPE "ApiAuthType" ADD VALUE IF NOT EXISTS 'BASIC';
