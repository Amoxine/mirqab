import type { Plan } from '@prisma/client';
import { QuotaPeriod } from '@prisma/client';

/** Same table as the key mapper's; duplicated rather than imported to keep plans free of keys. */
const PERIOD_SECONDS: Record<QuotaPeriod, number> = {
  [QuotaPeriod.HOURLY]: 3600,
  [QuotaPeriod.DAILY]: 86_400,
  [QuotaPeriod.WEEKLY]: 604_800,
  [QuotaPeriod.MONTHLY]: 2_592_000, // 30 days
};

/**
 * A plan's Tyk policy (WP18). Pure, so it is testable without a gateway.
 *
 * **The policy id IS `plan.id`.** Not a derived or prefixed value: a key assigned to this plan
 * carries `apply_policies: [plan.id]`, so there is exactly one identifier and nothing to keep in
 * sync. The gateway runs with `allow_explicit_policy_id`, which is what permits supplying it.
 *
 * Two Tyk conventions are load-bearing here and both read backwards:
 *   - `rate: 0` / `per: 0` means NO rate limiting, not "zero requests allowed". `buildJwtPolicy`
 *     relies on the same reading.
 *   - `quota_max: -1` means unlimited. Zero would be a quota of nothing.
 * Getting either inverted produces a policy the gateway accepts and then enforces as a total block.
 *
 * `partitions.acl: false` is a WP18 fix, live-verified against Tyk 5.15.0. `POST /tyk/keys/create`
 * refuses `apply_policies` unless a referenced policy owns non-empty `access_rights` — checked on the
 * policy regardless of what the key's own says — so this policy, staying ACL-less by design (a plan
 * is a limit tier, not a grant of APIs), can never satisfy that gate alone. `partitions` says so
 * explicitly and confines this policy to rate/quota: a plan-governed key applies a SECOND policy
 * alongside this one — `buildKeyAclPolicy`, `partitions.acl: true`, the key's own real access rights
 * — which is what actually gets it past the gate. Without an explicit `partitions.acl: false` here,
 * an unpartitioned policy becomes the session's EXCLUSIVE access-rights source and would silently
 * overwrite the ACL policy's grant instead of leaving it alone (verified live).
 */
export function buildPlanPolicy(
  plan: Pick<Plan, 'id' | 'name' | 'rate' | 'per' | 'quotaMax' | 'quotaPeriod' | 'active'>,
  tykOrgId: string,
  accessRights: Record<string, unknown> = {},
): Record<string, unknown> {
  const unlimitedRate = plan.rate <= 0;

  return {
    id: plan.id,
    name: plan.name,
    org_id: tykOrgId,
    active: plan.active,
    state: plan.active ? 'active' : 'draft',
    rate: unlimitedRate ? 0 : plan.rate,
    // `per` must be 0 alongside rate 0, or Tyk reads a window with no allowance.
    per: unlimitedRate ? 0 : plan.per,
    quota_max: plan.quotaMax,
    quota_renewal_rate: plan.quotaMax < 0 ? 0 : PERIOD_SECONDS[plan.quotaPeriod],
    // Empty `access_rights` means the policy grants nothing of its own and the key keeps the API
    // scope it was created with. A plan is a limit tier, not a grant of APIs — products do that.
    access_rights: accessRights,
    // See the doc comment above: this policy must not be able to own ACL, or it would clobber the
    // real access rights the paired `buildKeyAclPolicy` policy provides.
    partitions: { quota: true, rate_limit: true, acl: false, complexity: false, per_api: false },
  };
}
