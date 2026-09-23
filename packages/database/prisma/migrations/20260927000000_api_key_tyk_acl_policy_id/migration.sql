-- WP18 fix, live-verified against a real multi-node Tyk 5.15.0 gateway: a plan-governed key's
-- `apply_policies` array needs a SECOND policy id alongside the plan's — see api_keys.plan_id's
-- sibling column below and ApiKey.tykAclPolicyId's doc comment in schema.prisma for why.
--
-- Nullable with no backfill, same reasoning as plan_id: a pre-fix or non-plan key has none and
-- keeps working untouched. Guarded so a repeat deploy and a shadow-DB replay are both no-ops.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "tyk_acl_policy_id" TEXT;
