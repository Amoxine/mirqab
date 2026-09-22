import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { quotaPeriodToSeconds, type KeyLimits } from '../../keys/services/tyk-key-mapper';

/** The API an OAuth2 client is scoped to. Tyk refuses a policy with no access rights. */
export interface ClientApiScope {
  name: string;
  /** `null` until the API has been synced to the gateway; a client cannot be issued before then. */
  tykApiId: string | null;
}

/** Per-client rate / quota, same fields and same "0 = unlimited" rule as an API key's. */
export type ClientLimits = KeyLimits;

/** 32 bytes of entropy, URL-safe so it survives a form-encoded token request unescaped. */
export const generateClientSecret = (): string => randomBytes(32).toString('base64url');

/**
 * The Hydra OAuth2 client for an API consumer.
 *
 * `client_credentials` only: these are machine credentials for the data plane, never a browser
 * login, so there are no redirect URIs and no refresh tokens. `owner` carries the tenant id because
 * it is the only field Hydra's list endpoint can filter on server-side; `metadata` carries the same
 * tenant id plus the API, and is the authoritative scoping record (there is no local table).
 *
 * `client_secret_post` rather than `_basic`: both work, this is the one verified end to end against
 * v26.2.0 and the one the dashboard's copy-paste `curl` snippet shows.
 */
export function buildHydraClientDef(input: {
  name: string;
  tenantId: string;
  apiDefId: string;
  secret: string;
}): Record<string, unknown> {
  return {
    client_name: input.name,
    client_secret: input.secret,
    grant_types: ['client_credentials'],
    response_types: [],
    redirect_uris: [],
    scope: '',
    token_endpoint_auth_method: 'client_secret_post',
    owner: input.tenantId,
    metadata: { tenantId: input.tenantId, apiDefId: input.apiDefId },
  };
}

/**
 * The Tyk policy that authorizes one OAuth2 client on one API, and carries that client's limits.
 *
 * **The policy id is the client id on purpose.** Tyk resolves a JWT to a policy through
 * `jwt_policy_field_name`, and the only claim Hydra puts in a client_credentials token that names
 * the client is `client_id` (a string — verified: Tyk rejects an array-valued policy claim with
 * "No policies could be determined from token"). Naming the policy after the client therefore needs
 * no Hydra token hook at all, and `access_rights` is what keeps a client scoped to its own API: the
 * same token gets 403 "key not authorized: no matching policy found" on any other API.
 *
 * It is also what makes revocation immediate. Tyk validates these tokens offline against Hydra's
 * JWKS, so deleting the Hydra client alone would leave already-issued tokens working until they
 * expire; deleting this policy is what stops them.
 *
 * Limits mirror `buildTykKeyDef`: `rate` is per second, unset means unlimited (verified on Tyk
 * v5.15.0 — `rate: 0` lets 6/6 requests through), and the API's own `global_rate_limit` still
 * applies on top for every caller.
 */
export function buildTykPolicy(
  clientName: string,
  api: ClientApiScope,
  limits: ClientLimits,
  orgId: string,
): Record<string, unknown> {
  if (!api.tykApiId) {
    throw new BadRequestException('API is not synced to the gateway yet, try again in a moment');
  }

  const policy: Record<string, unknown> = {
    // `id` is filled in by the caller with the Hydra client id — see above.
    name: `${api.name} — ${clientName}`,
    org_id: orgId,
    active: true,
    state: 'active',
    rate: 0,
    per: 0,
    quota_max: -1,
    access_rights: {
      [api.tykApiId]: { api_id: api.tykApiId, api_name: api.name, versions: ['Default'] },
    },
  };

  if (limits.rateLimitPerSecond) {
    policy.rate = limits.rateLimitPerSecond;
    policy.per = 1;
  }

  if (limits.quotaLimit) {
    if (!limits.quotaPeriod) {
      throw new BadRequestException('quotaPeriod is required when quotaLimit is set');
    }
    policy.quota_max = limits.quotaLimit;
    policy.quota_renewal_rate = quotaPeriodToSeconds(limits.quotaPeriod);
  }

  return policy;
}
