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

function accessRightsFor(apiDef: KeyApiScope | null): Record<string, unknown> | undefined {
  if (!apiDef?.tykApiId) return undefined;
  return { [apiDef.tykApiId]: { api_id: apiDef.tykApiId, api_name: apiDef.name, versions: ['Default'] } };
}

/**
 * Tyk key definition for a NEW key. Unlimited rate / quota are expressed by omitting the fields.
 * Pure: `orgId` (the owning tenant's `Tenant.tykOrgId`, the same org its API definitions carry — see
 * `loadTenantScope`) and `nowSeconds` are injected so the mapper is testable. It is no longer the
 * gateway-wide `TYK_ORG_ID`: one org for everyone meant cutting off a single tenant cut off all of
 * them (WP12c).
 */
export function buildTykKeyDef(
  input: KeyDefInput,
  apiDef: KeyApiScope | null,
  orgId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const def: Record<string, unknown> = { alias: input.name, active: true, org_id: orgId };

  const accessRights = accessRightsFor(apiDef);
  if (accessRights) def.access_rights = accessRights;

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
