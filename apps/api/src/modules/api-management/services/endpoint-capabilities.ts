/**
 * What Tyk OSS 5.15.0 ENFORCES per OpenAPI operation (OAS-02).
 *
 * `x-tyk-api-gateway.middleware.operations.<operationId>` ACCEPTS 23 controls
 * (`__fixtures__/tyk-oas-operation-fields.v5.15.0.json`, read from the gateway's own embedded schema).
 * Accepting is not enforcing — `mcpTools.rateLimit` in this repo validated, round-tripped and was never
 * enforced — so every entry below was tested with a request that must change behaviour and a control
 * request that must not, against the pinned image, by
 * `apps/api/test/e2e/oas-endpoint-capabilities.e2e.mjs`. That script IS the evidence: a Tyk upgrade that
 * changes any behaviour recorded here fails it. The write-up is `docs/OAS-ENDPOINT-CAPABILITIES.md`.
 *
 * Nothing in the product may offer a per-endpoint control that is not `enforced` here.
 *
 * BEHAVIOURS THE MAPPER MUST RESPECT (all measured, all in the e2e):
 *  1. A REAL operation wins over a templated catch-all. Once an API declares real operations, API-wide
 *     middleware that the mapper hosts on catch-alls (circuit breaker, URL rewrite, mock, body transforms,
 *     request validation) does NOT reach them — it must be copied onto each real operation.
 *  2. `{param}` matches ONE path segment and a trailing slash is a different route, so the catch-all is a
 *     family (bare path and 1..8 segments, each with a trailing-slash twin: `endpoint-operations.ts`).
 *  3. `cache` is only enforced when `middleware.global.cache.enabled` is on; with
 *     `cacheAllSafeRequests: false` only operations that opt in are cached.
 *  4. A per-operation `rateLimit` is ONE counter shared by every consumer, not a per-key limit.
 */

export type EndpointControl =
  | 'block'
  | 'allow'
  | 'ignoreAuthentication'
  | 'rateLimit'
  | 'cache'
  | 'validateRequest'
  | 'mockResponse'
  | 'enforceTimeout'
  | 'requestSizeLimit';

/**
 * - `enforced`: proven to change gateway behaviour on 5.15.0.
 * - `enforced-with-prerequisite`: proven, but only while `prerequisite` is also configured.
 * - `unverified`: accepted by the schema, not (yet) proven to be enforced. NOT to be offered.
 */
export type CapabilityStatus = 'enforced' | 'enforced-with-prerequisite' | 'unverified';

export interface EndpointCapability {
  /** The field under `x-tyk-api-gateway.middleware.operations.<operationId>`. */
  tykField: string;
  status: CapabilityStatus;
  /** Only for `enforced-with-prerequisite`. */
  prerequisite?: string;
  /** What the control does, in the terms an operator needs (the gateway's observed behaviour). */
  behaviour: string;
}

export const ENDPOINT_CAPABILITIES: readonly EndpointCapability[] = [
  { tykField: 'block', status: 'enforced', behaviour: 'answers 403 "Requested endpoint is forbidden" without reaching the upstream; matches templated paths ({id}); siblings and other methods on the same path are unaffected' },
  { tykField: 'allow', status: 'enforced', behaviour: 'ONE `allow` on an API turns on allow-list mode: every declared operation without it, and every undeclared path, answers 403' },
  { tykField: 'ignoreAuthentication', status: 'enforced', behaviour: 'on an authenticated API the operation answers without a key (200) while its siblings still answer 401' },
  { tykField: 'rateLimit', status: 'enforced', behaviour: 'answers 429 past `rate` per `per` (e.g. "60s"); ONE counter shared by all consumers, not per key; undecorated siblings unaffected' },
  { tykField: 'cache', status: 'enforced-with-prerequisite', prerequisite: 'middleware.global.cache.enabled = true (use cacheAllSafeRequests: false so only opted-in operations are cached)', behaviour: 'serves repeat GETs from cache without reaching the upstream; on its own, without the global switch, it does nothing' },
  { tykField: 'validateRequest', status: 'enforced', behaviour: 'validates the body against the operation\'s requestBody schema; answers errorResponseCode (e.g. 422) for a non-conforming body without reaching the upstream' },
  { tykField: 'mockResponse', status: 'enforced', behaviour: 'answers the configured code, body and headers without reaching the upstream' },
  { tykField: 'enforceTimeout', status: 'enforced', behaviour: 'answers 504 once the upstream takes longer than `value` seconds' },
  { tykField: 'requestSizeLimit', status: 'enforced', behaviour: 'answers 400 (not 413) for a body over `value` bytes' },

  // Accepted by the schema, not proven here. `circuitBreaker` and `urlRewrite` were verified live in
  // earlier work packages on the synthetic catch-all only, not on real operations.
  { tykField: 'circuitBreaker', status: 'unverified', behaviour: 'proven on the catch-all for HTTP 5xx only (WP15a); not on real operations' },
  { tykField: 'urlRewrite', status: 'unverified', behaviour: 'proven on the catch-all (WP15b); not on real operations' },
  { tykField: 'transformRequestBody', status: 'unverified', behaviour: 'not probed on real operations' },
  { tykField: 'transformResponseBody', status: 'unverified', behaviour: 'not probed on real operations' },
  { tykField: 'transformRequestHeaders', status: 'unverified', behaviour: 'not probed on real operations' },
  { tykField: 'transformResponseHeaders', status: 'unverified', behaviour: 'not probed on real operations' },
  { tykField: 'transformRequestMethod', status: 'unverified', behaviour: 'not probed' },
  { tykField: 'internal', status: 'unverified', behaviour: 'not probed' },
  { tykField: 'virtualEndpoint', status: 'unverified', behaviour: 'needs a scripting runtime; not probed' },
  { tykField: 'trackEndpoint', status: 'unverified', behaviour: 'not probed' },
  { tykField: 'doNotTrackEndpoint', status: 'unverified', behaviour: 'not probed' },
  { tykField: 'postPlugins', status: 'unverified', behaviour: 'custom plugins are not used in this deployment' },
  { tykField: 'scopeCheck', status: 'unverified', behaviour: 'OAuth scopes; not probed' },
  { tykField: 'exchange', status: 'unverified', behaviour: 'OAuth2 token exchange; not probed' },
];

/** Controls a product surface may offer. */
export const OFFERABLE_ENDPOINT_FIELDS: readonly string[] = ENDPOINT_CAPABILITIES.filter(
  (capability) => capability.status !== 'unverified',
).map((capability) => capability.tykField);

export function capabilityFor(tykField: string): EndpointCapability | undefined {
  return ENDPOINT_CAPABILITIES.find((capability) => capability.tykField === tykField);
}

/**
 * OAS-03: the governance control (as stored in `config.endpoints[key]`, plus the API-level
 * `restrictToSpec`) and the ONE Tyk operation field it is rendered to. Every value must be offerable:
 * `endpoint-capabilities.spec.ts` fails if a capability is flipped back to `unverified` while a
 * control still maps to it, and the mapper spec fails if the mapper emits a field outside this map.
 */
export const CONTROL_TYK_FIELD = {
  enabled: 'block',
  restrictToSpec: 'allow',
  auth: 'ignoreAuthentication',
  rateLimit: 'rateLimit',
  cache: 'cache',
  timeoutSeconds: 'enforceTimeout',
  requestSizeLimitBytes: 'requestSizeLimit',
  mock: 'mockResponse',
  validateRequestSchema: 'validateRequest',
} as const satisfies Record<string, EndpointControl>;

export type GovernanceControl = keyof typeof CONTROL_TYK_FIELD;

/**
 * Controls that only mean something on some methods. `cache`: Tyk caches safe requests and this
 * product offers it on GET only. `validateRequestSchema`: validates a request BODY.
 */
export const CONTROL_METHODS: Partial<Record<GovernanceControl, readonly string[]>> = {
  cache: ['GET'],
  validateRequestSchema: ['POST', 'PUT', 'PATCH'],
};

/** The capability table in the terms of the governance API: `control` is the stored name when one maps to the field. */
export function governanceCapabilities(): {
  control: string;
  status: CapabilityStatus;
  prerequisite?: string;
  behaviour: string;
}[] {
  const controlOf = new Map<string, string>(Object.entries(CONTROL_TYK_FIELD).map(([control, field]) => [field, control]));
  return ENDPOINT_CAPABILITIES.map(({ tykField, status, prerequisite, behaviour }) => ({
    control: controlOf.get(tykField) ?? tykField,
    status,
    ...(prerequisite ? { prerequisite } : {}),
    behaviour,
  }));
}
