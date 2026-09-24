import { BadRequestException } from '@nestjs/common';
import { QuotaPeriod } from '@prisma/client';
import type { TykKeyState } from '../../tyk-integration/services/tyk-client.service';

const PERIOD_SECONDS: Record<QuotaPeriod, number> = {
  [QuotaPeriod.HOURLY]: 3600,
  [QuotaPeriod.DAILY]: 86_400,
  [QuotaPeriod.WEEKLY]: 604_800,
  [QuotaPeriod.MONTHLY]: 2_592_000, // 30 days
};

/** The API a key is scoped to; Tyk refuses a key without at least one access right. */
export interface KeyApiScope {
  name: string;
  tykApiId: string | null;
  /**
   * WP28: present only for an MCP proxy — the tool names this key may call, derived from its plan
   * against each tool's own binding (`mcpToolGrants`). An empty array is meaningful and is NOT the
   * same as omitting the field: it grants no tool at all, which is what a key whose plan matches
   * none of the bindings should get.
   */
  mcpTools?: string[];
}

/** Limit fields shared by CreateKeyDto and UpdateKeyDto. `0` means "unlimited" for both limits. */
export interface KeyLimits {
  rateLimitPerSecond?: number;
  quotaLimit?: number;
  quotaPeriod?: QuotaPeriod;
}

export interface KeyDefInput extends KeyLimits {
  name: string;
  expiresAt?: string;
  /**
   * WP18. When set, the key's limits come from this plan's Tyk policy and the key carries NO
   * inline `rate`/`per`/`quota_max` — that is what makes editing the plan change every key at once.
   * The value is the `Plan.id`, which IS the Tyk policy id (see the Plan model).
   */
  planId?: string | null;
}

export interface KeyUpdateInput extends KeyLimits {
  name?: string;
  /** `null` clears the expiry. */
  expiresAt?: string | null;
}

export function quotaPeriodToSeconds(period: QuotaPeriod): number {
  return PERIOD_SECONDS[period];
}

const toEpochSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/**
 * One API, or several (WP22: a portal subscription grants every API a `Product` bundles, not just
 * one) — every existing call site passes a single scope or `null`, so this is purely additive.
 */
type KeyApiScopes = KeyApiScope | KeyApiScope[] | null;

function accessRightsFor(apis: KeyApiScopes): Record<string, unknown> | undefined {
  const list = apis === null ? [] : Array.isArray(apis) ? apis : [apis];
  const withTykId = list.filter((api): api is KeyApiScope & { tykApiId: string } => api.tykApiId !== null);
  if (withTykId.length === 0) return undefined;

  return Object.fromEntries(
    withTykId.map((api) => [
      api.tykApiId,
      {
        api_id: api.tykApiId,
        api_name: api.name,
        versions: ['Default'],
        // WP28 (TBAC). Only the policy that owns the `acl` partition is read for this — a key's
        // companion ACL policy, or an unplanned key's own inline session, both of which are built
        // from here. On a plan's policy the same field is stored and silently ignored, verified
        // against v5.15.0; see mcp-mapper.ts.
        ...(api.mcpTools ? { mcp_access_rights: { tools: { allowed: api.mcpTools } } } : {}),
      },
    ]),
  );
}

/**
 * The companion ACL policy a plan-governed key needs alongside its plan (WP18 fix). Null when the
 * key has no API to grant (`accessRightsFor` returns nothing) — nothing to grant, no policy needed.
 *
 * Live-verified on Tyk 5.15.0: `POST /tyk/keys/create` refuses `apply_policies` unless a REFERENCED
 * POLICY owns non-empty access rights, checked regardless of the key's own `access_rights`. The plan
 * policy is deliberately ACL-less and shared (`buildPlanPolicy`'s `partitions.acl: false` — a plan is
 * a limit tier, not a grant of APIs), so it can never satisfy that gate; this is the policy that does,
 * one per key so the grant it carries is only ever this one key's own scope. `partitions.acl: true`
 * (and everything else false) is what stops it from also swallowing the plan's rate/quota — without
 * it, whichever unpartitioned/ACL-owning policy is applied becomes the SESSION'S EXCLUSIVE source for
 * everything, not just ACL (verified live: it silently overwrote the plan's rate too).
 */
export function buildKeyAclPolicy(
  id: string,
  apis: KeyApiScopes,
  orgId: string,
): Record<string, unknown> | null {
  const accessRights = accessRightsFor(apis);
  if (!accessRights) return null;

  return {
    id,
    name: `Key access — ${id}`,
    org_id: orgId,
    active: true,
    state: 'active',
    // Inert: this policy never owns rate/quota (partitions below), so these values are never read.
    rate: 0,
    per: 0,
    quota_max: -1,
    quota_renewal_rate: 0,
    access_rights: accessRights,
    partitions: { quota: false, rate_limit: false, acl: true, complexity: false, per_api: false },
  };
}

/**
 * Tyk key definition for a NEW key. Unlimited rate / quota are expressed by omitting the fields.
 * Pure: `orgId` (the owning tenant's `Tenant.tykOrgId`, the same org its API definitions carry — see
 * `loadTenantScope`) and `nowSeconds` are injected so the mapper is testable. It is no longer the
 * gateway-wide `TYK_ORG_ID`: one org for everyone meant cutting off a single tenant cut off all of
 * them (WP12c).
 *
 * `aclPolicyId` is the id of a policy already built by `buildKeyAclPolicy` and pushed to Tyk by the
 * caller (this function stays pure — it has no gateway access) — see that function's doc comment for
 * why a planned key needs one. Omitted for a non-plan key, which does not.
 */
export function buildTykKeyDef(
  input: KeyDefInput,
  apis: KeyApiScopes,
  orgId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  aclPolicyId?: string,
): Record<string, unknown> {
  const def: Record<string, unknown> = { alias: input.name, active: true, org_id: orgId };

  const accessRights = accessRightsFor(apis);
  if (accessRights) def.access_rights = accessRights;

  // WP18: a planned key delegates its limits to the plan's policy and carries none of its own.
  //
  // The exclusivity is the whole feature, not tidiness. Tyk applies a policy's rate/quota on top of
  // the session, and an inline `rate` on the key wins over the policy's — so a key that kept its own
  // limits would silently ignore a plan edit, which is exactly the behaviour this replaces. Refusing
  // the combination outright is better than picking a winner: a caller who sent both wanted
  // something, and neither answer is obviously it.
  if (input.planId) {
    if (input.rateLimitPerSecond ?? input.quotaLimit) {
      throw new BadRequestException(
        'A key with planId cannot also set rateLimitPerSecond or quotaLimit — the plan defines both.',
      );
    }
    def.apply_policies = aclPolicyId ? [input.planId, aclPolicyId] : [input.planId];
  } else {
    if (input.rateLimitPerSecond) {
      def.rate = input.rateLimitPerSecond;
      def.per = 1;
    }

    if (input.quotaLimit) {
      if (!input.quotaPeriod) {
        throw new BadRequestException('quotaPeriod is required when quotaLimit is set');
      }
      const period = quotaPeriodToSeconds(input.quotaPeriod);
      def.quota_max = input.quotaLimit;
      def.quota_renewal_rate = period;
      def.quota_renews = nowSeconds + period;
    }
  }

  if (input.expiresAt) def.expires = toEpochSeconds(input.expiresAt);

  return def;
}

/**
 * Tyk key definition for an UPDATE. `PUT /tyk/keys/{hash}` replaces the whole session, so this starts
 * from the live Tyk state and overrides only what the caller sent; everything else (including
 * `access_rights`) is resent unchanged. `org_id` is re-set from `orgId` because `TykClientService.getKey`
 * strips it from the state, so the spread alone would reset the key to no org.
 */
export function applyKeyUpdate(
  current: TykKeyState,
  patch: KeyUpdateInput,
  apiDef: KeyApiScope | null,
  orgId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const def: Record<string, unknown> = { ...current, org_id: orgId };

  if (patch.name !== undefined) def.alias = patch.name;

  if (patch.rateLimitPerSecond !== undefined) {
    if (patch.rateLimitPerSecond > 0) {
      def.rate = patch.rateLimitPerSecond;
      def.per = 1;
    } else {
      delete def.rate;
      delete def.per;
    }
  }

  if (patch.quotaLimit !== undefined || patch.quotaPeriod !== undefined) {
    const limit = patch.quotaLimit ?? current.quota_max ?? 0;
    if (limit > 0) {
      const period = patch.quotaPeriod ? quotaPeriodToSeconds(patch.quotaPeriod) : (current.quota_renewal_rate ?? 0);
      if (period <= 0) throw new BadRequestException('quotaPeriod is required when setting a quota');
      def.quota_max = limit;
      def.quota_renewal_rate = period;
      // Keep the running window when the quota itself is unchanged.
      const unchanged = limit === current.quota_max && period === current.quota_renewal_rate && !!current.quota_renews;
      if (!unchanged) def.quota_renews = nowSeconds + period;
    } else {
      delete def.quota_max;
      delete def.quota_renewal_rate;
      delete def.quota_renews;
    }
  }

  if (patch.expiresAt === null) delete def.expires;
  else if (patch.expiresAt !== undefined) def.expires = toEpochSeconds(patch.expiresAt);

  const accessRights = accessRightsFor(apiDef);
  if (accessRights && Object.keys(current.access_rights ?? {}).length === 0) def.access_rights = accessRights;

  return def;
}
