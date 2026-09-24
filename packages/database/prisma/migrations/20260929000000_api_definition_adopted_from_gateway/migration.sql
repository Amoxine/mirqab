-- WP25: "adopt from gateway" (P2's audited escape hatch). Stores the raw definition read from one
-- node, verbatim, when an operator deliberately overrides Postgres as config of record with what a
-- node is actually running. Nullable with no backfill: a row that has never been adopted has none.
-- Guarded so a repeat deploy and a shadow-DB replay are both no-ops.

ALTER TABLE "api_definitions" ADD COLUMN IF NOT EXISTS "adopted_from_gateway" JSONB;
