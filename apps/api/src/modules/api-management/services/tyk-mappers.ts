import { ApiStatus, type ApiDefinition, type Prisma } from '@prisma/client';
import type { ApiConfig } from '../dto/api-config.dto';
import type { TenantGatewayScope } from '../../tyk-integration/services/tenant-scope';

/**
 * Both Tyk definition formats — classic and Tyk-OAS — in one place.
 *
 * Extracted from `api.service.ts` as a PURE MOVE, no logic changed. That file had grown past 1200
 * lines carrying the response types, the service class and both mappers at once, which made it the
 * single file every gateway-shaped work package had to edit: four landed on it consecutively and
 * two of them collided outright. The mappers' own history lives in `api.service.ts` up to this
 * commit.
 *
 * `readConfig`, `jwtPolicyId`, `gatewayListenPath` and `buildJwtPolicy` are exported rather than
 * private because `ApiService` needs them too. They live HERE rather than in the service so the
 * dependency runs one way — service imports mappers, never the reverse — which is what stops this
 * becoming a circular import.
 */

/** `ApiDefinition.config` is free-form JSON in the schema; anything that is not an object reads as empty. */
export function readConfig(value: Prisma.JsonValue | null): ApiConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ApiConfig) : {};
}

/**
 * Tyk's JWT middleware fields for an `authType: OAUTH` API, i.e. one whose consumers authenticate
 * with a Hydra `client_credentials` access token.
 *
 * `jwtSource` is the base64 PEM of Hydra's access-token signing key (see `hydra-signing-key.ts` for
 * why it is pinned rather than pointed at a JWKS URL).
 *
 * That choice is now load-bearing for more than key rotation: it's WHY `tyk-gateway` can live on a
 * Docker network with no route to Hydra (see the network-split comment in infra/docker-compose.yml)
 * without breaking this data-plane auth. Tyk verifies every OAuth2 API's tokens from this embedded
 * PEM alone, zero Hydra calls. If `jwt_source` is ever switched to a live JWKS URL for non-breaking
 * rotation, every OAUTH-type API would need Hydra reachable from tyk-gateway again — reopening the
 * network hole that split was built to close, with a symptom (every such API 401ing) that points
 * nowhere near the network config. Don't make that switch without revisiting the split too.
 *
 * `jwt_policy_field_name: 'client_id'` is what maps a token to its Tyk policy: each OAuth2 client
 * gets a policy whose id IS its client id (see `oauth-clients/services/oauth-client-mapper.ts`), so
 * no Hydra token hook is needed, and a client only reaches the API its policy grants — the same
 * token answers 403 "key not authorized: no matching policy found" anywhere else. The claim has to
 * be a string: Tyk cannot resolve a policy from an array-valued claim. `jwt_default_policies` stays
 * empty on purpose, so a token with no matching policy is denied rather than defaulted.
 *
 * `use_oauth2` is NOT set: that switches on Tyk's own OAuth2 provider, which Hydra replaces.
 */
function jwtFieldsForOAuth(jwtSource: string): Record<string, unknown> {
  return {
    jwt_signing_method: 'rsa',
    jwt_source: jwtSource,
    jwt_identity_base_field: 'sub',
    jwt_policy_field_name: 'client_id',
    jwt_default_policies: [],
  };
}

/**
 * The Tyk policy id for an `authType: JWT` api's bring-your-own-JWKS policy (O3). Deterministic
 * (not a Hydra client id like OAuth's — there is no per-consumer client here), so `syncToTyk` can
 * compute it before the policy exists and reference it from `jwt_default_policies` on the very
 * first write.
 */
export const jwtPolicyId = (apiDefId: string): string => `og-jwt-${apiDefId}`;

/**
 * Tyk's JWT middleware fields for `authType: JWT` (O3, bring-your-own JWKS — the fix for the
 * `enable_jwt`-with-nothing-else bug this replaces, see the comment below).
 *
 * Unlike OAuth's per-Hydra-client policy, there is exactly one policy for every caller of this API:
 * `jwt_default_policies` (not `jwt_policy_field_name`) is set, so ANY token whose signature verifies
 * against `jwksUrl` is authorized identically — Tyk has no concept of "which external subject" here,
 * only "did this verify against the configured JWKS". A `jwt_policy_field_name` claim-to-policy
 * mapping would need a policy to already exist per claim value, which nothing here provisions.
 *
 * No explicit issuer check: Tyk classic API definitions have no `jwt_issuer`-style field (verified
 * against gateway/mw_jwt.go on the pinned v5.15.0 tag — the only issuer-aware code path is the OAS
 * multi-IdP "registry", which a classic definition never populates). "Wrong issuer" is still
 * rejected, because that token is signed by a key that is not IN `jwksUrl` — `issuer` is recorded on
 * the API for reference/audit only, not fed into the gateway.
 */
function jwtFieldsForBringYourOwnJwks(apiDefId: string, jwksUrl: string, identityField: string | undefined) {
  return {
    jwt_signing_method: 'rsa',
    jwt_source: jwksUrl,
    jwt_identity_base_field: identityField ?? 'sub',
    jwt_default_policies: [jwtPolicyId(apiDefId)],
  };
}

/**
 * What the gateway actually routes on: `/{tenantSlug}{listenPath}` (O10). `listenPath` always starts
 * with `/`, so a tenant's `/payments/` becomes `/acme/payments/` and a root `/` becomes `/acme/`.
 * Tenant slugs are globally unique, so two tenants' paths can never collide — which is what lets
 * `ApiDefinition.listenPath` be unique per tenant instead of globally.
 */
export const gatewayListenPath = (tenantSlug: string, listenPath: string): string =>
  `/${tenantSlug}${listenPath}`;

/** Header clients select a version with (WP16). Fixed rather than configurable — one convention product-wide. */
export const VERSION_HEADER = 'x-api-version';

/**
 * The one policy every valid JWT for this API is mapped to (see `jwtFieldsForBringYourOwnJwks`).
 * Unlimited on top of whatever the API's own `global_rate_limit` already applies — the same
 * no-extra-limit baseline `buildTykPolicy` uses when an OAuth2 client sets none (`oauth-client-mapper.ts`).
 * Per-subject limits are a plans/policies feature (WP18), not this bug fix's job.
 */
export function buildJwtPolicy(
  apiDef: Pick<ApiDefinition, 'id' | 'name'>,
  tykApiId: string,
  tykOrgId: string,
): Record<string, unknown> {
  return {
    id: jwtPolicyId(apiDef.id),
    name: `${apiDef.name} — JWT`,
    org_id: tykOrgId,
    active: true,
    state: 'active',
    rate: 0,
    per: 0,
    quota_max: -1,
    access_rights: {
      [tykApiId]: { api_id: tykApiId, api_name: apiDef.name, versions: ['Default'] },
    },
  };
}

/**
 * Tyk definition for an API. Only `config`-driven keys are conditional; every other field is
 * unconditional. `jwtSource` (the base64 PEM from `fetchAccessTokenSigningKey`) is required for an
 * `authType: OAUTH` api and ignored for every other auth type.
 */
export function mapToTykFormat(
  apiDef: ApiDefinition,
  tenant: TenantGatewayScope,
  jwtSource = '',
): Record<string, unknown> {
  const {
    rateLimit, cors, doNotTrack, jwt, throttle, timeoutSeconds, circuitBreaker, requestSizeLimitBytes,
    loadBalancing, uptimeTests, transformRequestHeaders, transformResponseHeaders, urlRewrite, mock,
    transformRequestBody, transformResponseBody, cache, detailedRecording,
    ipAccessControl, validateRequestSchema, authHeaderName, hmac,
  } = readConfig(apiDef.config);
  const authHeader = authHeaderName ?? 'Authorization';

  // Classic keeps per-path middleware under `extended_paths`, so an API-WIDE timeout, size limit or
  // circuit breaker is expressed as a single entry whose path matches everything. `/.*` is Tyk's
  // own convention for that (the field is a regex, not a literal path).
  const extendedPaths: Record<string, unknown> = {};
  if (timeoutSeconds) {
    extendedPaths.hard_timeouts = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      timeout: timeoutSeconds,
    }));
  }
  if (requestSizeLimitBytes) {
    extendedPaths.size_limits = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      size_limit: requestSizeLimitBytes,
    }));
  }
  if (transformRequestHeaders) {
    extendedPaths.transform_headers = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      add_headers: Object.fromEntries((transformRequestHeaders.add ?? []).map((h) => [h.name, h.value])),
      delete_headers: transformRequestHeaders.remove ?? [],
    }));
  }
  if (transformResponseHeaders) {
    extendedPaths.transform_response_headers = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      add_headers: Object.fromEntries((transformResponseHeaders.add ?? []).map((h) => [h.name, h.value])),
      delete_headers: transformResponseHeaders.remove ?? [],
    }));
  }
  if (urlRewrite) {
    extendedPaths.url_rewrites = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      match_pattern: urlRewrite.pattern,
      rewrite_to: urlRewrite.rewriteTo,
    }));
  }
  if (mock) {
    // Classic expresses a mock as a "virtual" allow-listed path carrying the canned response.
    extendedPaths.white_list = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method_actions: {
        [method]: {
          action: 'reply',
          code: mock.code,
          data: mock.body,
          headers: Object.fromEntries((mock.headers ?? []).map((h) => [h.name, h.value])),
        },
      },
    }));
  }
  if (transformRequestBody) {
    extendedPaths.transform = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      template_data: { template_mode: 'blob', template_source: transformRequestBody.body, input_type: transformRequestBody.format },
    }));
  }
  if (transformResponseBody) {
    extendedPaths.transform_response = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      template_data: { template_mode: 'blob', template_source: transformResponseBody.body, input_type: transformResponseBody.format },
    }));
  }
  if (cache) {
    extendedPaths.cache = ['/.*'];
  }
  if (validateRequestSchema) {
    // Classic carries the schema inline per path; OAS instead validates against the document's own
    // `requestBody`. Same behaviour, but the schema lives in a different place in each format.
    extendedPaths.validate_json = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      schema: validateRequestSchema,
      error_response_code: 422,
    }));
  }
  if (circuitBreaker) {
    extendedPaths.circuit_breakers = CATCH_ALL_METHODS.map((method) => ({
      path: '/.*',
      method,
      threshold_percent: circuitBreaker.threshold,
      samples: circuitBreaker.sampleSize,
      return_to_service_after: circuitBreaker.coolDownSeconds,
    }));
  }

  return {
    name: apiDef.name,
    api_id: apiDef.tykApiId ?? `og-${apiDef.id}`,
    org_id: tenant.tykOrgId,
    proxy: {
      listen_path: gatewayListenPath(tenant.slug, apiDef.listenPath),
      target_url: apiDef.proxyUrl,
      strip_listen_path: true,
      ...(loadBalancing && loadBalancing.targets.length > 0
        ? {
            enable_load_balancing: true,
            // Classic has no per-target weight field: a target is repeated `weight` times in the
            // list, which is how Tyk expresses weighting here. OAS takes {url, weight} directly.
            target_list: loadBalancing.targets.flatMap((t) => Array<string>(t.weight).fill(t.url)),
          }
        : {}),
    },
    // Tyk rejects traffic with 403 "Version information not found" without version_data.
    version_data: {
      not_versioned: true,
      versions: {
        Default: {
          name: 'Default',
          ...(Object.keys(extendedPaths).length > 0
            ? { use_extended_paths: true, extended_paths: extendedPaths }
            : {}),
        },
      },
    },
    use_keyless: apiDef.authType === 'NONE',
    use_standard_auth: apiDef.authType === 'AUTH_TOKEN',
    // OAUTH = a Hydra-issued client_credentials JWT, verified against Hydra's signing key. JWT (O3) =
    // bring-your-own JWKS, verified against `config.jwt.jwksUrl` — `ApiService.create`/`update` refuse
    // to save `authType: JWT` with no `jwt` section, so `jwt` is never undefined here in practice; the
    // `enable_jwt` flag alone (ex-bug: no source, no policy, 100% rejected) is never emitted again.
    enable_jwt: apiDef.authType === 'JWT' || apiDef.authType === 'OAUTH',
    ...(apiDef.authType === 'OAUTH' ? jwtFieldsForOAuth(jwtSource) : {}),
    ...(apiDef.authType === 'JWT' && jwt
      ? jwtFieldsForBringYourOwnJwks(apiDef.id, jwt.jwksUrl, jwt.identityField)
      : {}),
    auth: { auth_header_name: authHeader },
    // `use_basic_auth` / `enable_signature_checking` are what actually switch those middlewares on;
    // the auth block above only says which header carries the credential.
    use_basic_auth: apiDef.authType === 'BASIC',
    enable_signature_checking: apiDef.authType === 'HMAC',
    ...(apiDef.authType === 'HMAC' && hmac?.allowedAlgorithms ? { hmac_allowed_algorithms: hmac.allowedAlgorithms } : {}),
    ...(apiDef.authType === 'HMAC' && hmac?.allowedClockSkewMs !== undefined
      ? { hmac_allowed_clock_skew: hmac.allowedClockSkewMs }
      : {}),
    ...(ipAccessControl?.allow
      ? { enable_ip_whitelisting: true, allowed_ips: ipAccessControl.allow }
      : {}),
    ...(ipAccessControl?.block
      ? { enable_ip_blacklisting: true, blacklisted_ips: ipAccessControl.block }
      : {}),
    active: apiDef.status === ApiStatus.ACTIVE,
    ...(rateLimit
      ? { global_rate_limit: { rate: rateLimit.rate, per: rateLimit.per, disabled: rateLimit.rate === 0 } }
      : {}),
    ...(cors
      ? {
          // Tyk's key really is upper-case `CORS`.
          CORS: {
            enable: cors.enable,
            allowed_origins: cors.allowedOrigins,
            allowed_methods: cors.allowedMethods,
            allowed_headers: cors.allowedHeaders,
            exposed_headers: cors.exposedHeaders,
            allow_credentials: cors.allowCredentials,
            max_age: cors.maxAge,
            options_passthrough: false,
            debug: false,
          },
        }
      : {}),
    ...(doNotTrack === undefined ? {} : { do_not_track: doNotTrack }),
    // O9: per-API opt-in; the gateway-wide default stays false
    // (`TYK_GW_ANALYTICSCONFIG_ENABLEDETAILEDRECORDING`, infra/docker-compose.yml).
    ...(detailedRecording === undefined ? {} : { enable_detailed_recording: detailedRecording }),
    ...(cache
      ? {
          cache_options: {
            enable_cache: true,
            cache_timeout: cache.timeoutSeconds,
            cache_all_safe_requests: cache.cacheAllSafeRequests ?? true,
            ...(cache.cacheResponseCodes ? { cache_response_codes: cache.cacheResponseCodes } : {}),
          },
        }
      : {}),
    ...(throttle
      ? { global_rate_limit_throttle_retry_limit: throttle.retryLimit, global_rate_limit_throttle_interval: throttle.intervalSeconds }
      : {}),
    ...(uptimeTests && uptimeTests.length > 0
      ? {
          uptime_tests: {
            check_list: uptimeTests.map((t) => ({
              url: t.url,
              method: t.method ?? 'GET',
              ...(t.timeoutSeconds === undefined ? {} : { timeout: t.timeoutSeconds }),
            })),
          },
        }
      : {}),
  };
}

/**
 * Duration form Tyk-OAS wants for a rate-limit window.
 *
 * S6 caveat 1: the classic field `global_rate_limit.per` is a NUMBER OF SECONDS, while OAS's
 * `X-Tyk-RateLimit.per` is a duration STRING matching `^(\d+h)?(\d+m)?(\d+s)?$`. Emitting the raw
 * number is silently rejected by the schema, so the two formats are not interchangeable.
 */
const rateLimitPer = (seconds: number): string => `${String(seconds)}s`;

/**
 * Security-scheme key used in BOTH `components.securitySchemes` and the Tyk extension.
 *
 * S6 structural caveat: OAS requires the scheme to be declared TWICE and referenced by the same
 * name — once as a normal OpenAPI security scheme, once inside
 * `x-tyk-api-gateway.server.authentication.securitySchemes` — plus listed in the root `security`
 * array. A classic definition needs none of that; an OAS definition missing any of the three simply
 * does not authenticate (verified during S6).
 */
const SCHEME_NAME = { token: 'authToken', jwt: 'jwtAuth', hmac: 'hmacAuth', basic: 'basicAuth' } as const;

/**
 * Methods an API-wide middleware entry is expanded across.
 *
 * Both Tyk formats attach timeout / size-limit / circuit-breaker middleware PER PATH AND METHOD;
 * neither has an "any method" form. An API-level setting is therefore one entry per method, in both
 * mappers — emitting only GET would silently leave every write request unprotected.
 */
const CATCH_ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * OAS path template used for API-wide middleware. Tyk matches operations by the path template, so a
 * single templated segment stands in for the regex a classic definition would use (`/.*`).
 * Verified on v5.15.0: a breaker declared on this operation trips, and the gateway logs
 * `[CIRCUIT BREAKER] Breaker tripped for path: /{wildcard}`.
 */
const CATCH_ALL_PATH = '/{wildcard}';

const catchAllOperationId = (method: string): string => `catchAll${method}`;

/** One entry of a versioned base's `info.versioning.versions` array (WP16) — a child's own name and Tyk id. */
export interface ApiVersionChild {
  versionName: string;
  tykApiId: string;
}

/**
 * Tyk-OAS form of the same definition `mapToTykFormat` produces, for `defFormat: OAS` APIs.
 *
 * Deliberately a SIBLING of the classic mapper rather than a replacement: pre-WP13b rows are
 * labelled CLASSIC by the migration and keep being served from their classic definition until
 * something re-syncs them, so both mappers have to stay correct at the same time.
 *
 * Every one of the 13 named top-level keys the classic mapper emits has an equivalent here, and
 * `tyk-oas-mapper.spec.ts` asserts that key by key. The four places the two formats are NOT a
 * straight rename are called out inline below, because each one fails silently rather than loudly:
 * a wrong polarity or a number-where-a-string-is-expected produces a definition the gateway accepts
 * and then behaves differently from the classic one.
 *
 * `versions` (WP16): non-empty only when `apiDef` is the DEFAULT of a family with at least one
 * active (non-retired) child — the caller (`ApiService.syncToTykWithNodes`) is the one place that
 * knows the current sibling set, so this stays a pure function of its arguments rather than
 * querying the database itself.
 */
export function mapToTykOas(
  apiDef: ApiDefinition,
  tenant: TenantGatewayScope,
  jwtSource = '',
  versions: readonly ApiVersionChild[] = [],
): Record<string, unknown> {
  const {
    rateLimit, cors, doNotTrack, jwt, timeoutSeconds, requestSizeLimitBytes, loadBalancing, uptimeTests,
    circuitBreaker, transformRequestHeaders, transformResponseHeaders, urlRewrite, mock,
    transformRequestBody, transformResponseBody, cache, detailedRecording,
    ipAccessControl, validateRequestSchema, authHeaderName, hmac,
  } = readConfig(apiDef.config);
  // One place decides which header carries the key, so every scheme below agrees (WP15c).
  const authHeader = authHeaderName ?? 'Authorization';
  const isHmac = apiDef.authType === 'HMAC';
  const isBasic = apiDef.authType === 'BASIC';
  const isOAuth = apiDef.authType === 'OAUTH';

  const isJwt = apiDef.authType === 'JWT';
  const isToken = apiDef.authType === 'AUTH_TOKEN';

  // ── authentication, declared in both places OAS requires ────────────────
  const securitySchemes: Record<string, unknown> = {};
  const componentSchemes: Record<string, unknown> = {};
  const security: Record<string, string[]>[] = [];

  if (isToken) {
    securitySchemes[SCHEME_NAME.token] = {
      enabled: true,
      // classic `auth.auth_header_name` -> per-scheme `header.name` (it is per scheme in OAS, not
      // one global setting). Naming a custom header REPLACES Authorization rather than adding to
      // it, which is what makes the same key in Authorization fail.
      header: { enabled: true, name: authHeader },
    };
    componentSchemes[SCHEME_NAME.token] = { type: 'apiKey', in: 'header', name: authHeader };
    security.push({ [SCHEME_NAME.token]: [] });
  }

  if (isOAuth || isJwt) {
    securitySchemes[SCHEME_NAME.jwt] = {
      enabled: true,
      header: { enabled: true, name: authHeader },
      signingMethod: 'rsa',
      // OAUTH pins Hydra's base64 PEM; JWT (O3) points at the tenant's own JWKS URL. Tyk's `source`
      // accepts either, exactly as the classic `jwt_source` does.
      source: isOAuth ? jwtSource : (jwt?.jwksUrl ?? ''),
      identityBaseField: isOAuth ? 'sub' : (jwt?.identityField ?? 'sub'),
      // OAUTH maps each token to the policy whose id IS its client id; JWT has no per-consumer
      // client, so every valid token gets the one default policy instead. This asymmetry is why
      // OAUTH emits 5 jwt_* fields classically and JWT emits only 4 — `policyFieldName` is
      // OAUTH-only.
      ...(isOAuth ? { policyFieldName: 'client_id' } : {}),
      defaultPolicies: isOAuth ? [] : [jwtPolicyId(apiDef.id)],
    };
    componentSchemes[SCHEME_NAME.jwt] = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
    security.push({ [SCHEME_NAME.jwt]: [] });
  }

  // HMAC config is emitted but NOT verified end to end (WP15c). Tyk accepts the definition and
  // finds the key, but every signing string tried was rejected — `date: <v>`, the bare value,
  // `(request-target)` + date, a URL-encoded signature, an `x-tyk-date` header, and `keyId` as the
  // key hash (which regresses to "Key ID does not exist", confirming the raw key is correct and
  // ruling out `hash_keys`). Parked with the owner rather than claimed as working; see
  // `wp15c-acceptance.ts` for the full list before spending time on it again.
  if (isHmac) {
    securitySchemes[SCHEME_NAME.hmac] = {
      enabled: true,
      header: { enabled: true, name: authHeader },
      ...(hmac?.allowedAlgorithms ? { allowedAlgorithms: hmac.allowedAlgorithms } : {}),
      ...(hmac?.allowedClockSkewMs === undefined ? {} : { allowedClockSkew: hmac.allowedClockSkewMs }),
    };
    componentSchemes[SCHEME_NAME.hmac] = { type: 'apiKey', in: 'header', name: authHeader };
    security.push({ [SCHEME_NAME.hmac]: [] });
  }
  if (isBasic) {
    securitySchemes[SCHEME_NAME.basic] = { enabled: true, header: { enabled: true, name: authHeader } };
    componentSchemes[SCHEME_NAME.basic] = { type: 'http', scheme: 'basic' };
    security.push({ [SCHEME_NAME.basic]: [] });
  }

  const authenticated = Object.keys(securitySchemes).length > 0;

  // ── middleware.global ───────────────────────────────────────────────────
  const globalMiddleware: Record<string, unknown> = {};
  if (cors) {
    globalMiddleware.cors = {
      // classic `CORS.enable` -> OAS `cors.enabled`; the rest are the same nine fields renamed
      // from snake_case to camelCase.
      enabled: cors.enable,
      allowedOrigins: cors.allowedOrigins,
      allowedMethods: cors.allowedMethods,
      allowedHeaders: cors.allowedHeaders,
      exposedHeaders: cors.exposedHeaders,
      allowCredentials: cors.allowCredentials,
      maxAge: cors.maxAge,
      optionsPassthrough: false,
      debug: false,
    };
  }
  if (transformRequestHeaders) {
    globalMiddleware.transformRequestHeaders = {
      enabled: true,
      ...(transformRequestHeaders.add ? { add: transformRequestHeaders.add.map((h) => ({ name: h.name, value: h.value })) } : {}),
      ...(transformRequestHeaders.remove ? { remove: transformRequestHeaders.remove } : {}),
    };
  }
  if (transformResponseHeaders) {
    globalMiddleware.transformResponseHeaders = {
      enabled: true,
      ...(transformResponseHeaders.add ? { add: transformResponseHeaders.add.map((h) => ({ name: h.name, value: h.value })) } : {}),
      ...(transformResponseHeaders.remove ? { remove: transformResponseHeaders.remove } : {}),
    };
  }
  if (cache) {
    globalMiddleware.cache = {
      enabled: true,
      timeout: cache.timeoutSeconds,
      cacheAllSafeRequests: cache.cacheAllSafeRequests ?? true,
      ...(cache.cacheResponseCodes ? { cacheResponseCodes: cache.cacheResponseCodes } : {}),
    };
  }
  if (requestSizeLimitBytes) {
    // `X-Tyk-GlobalRequestSizeLimit`. Capped by the DTO at the edge's own limit, so this is always
    // the smaller of the two enforcers and the 413 comes from the gateway.
    globalMiddleware.requestSizeLimit = { enabled: true, value: requestSizeLimitBytes };
  }
  if (doNotTrack !== undefined) {
    // S6 caveat 3: POLARITY INVERTS. classic `do_not_track: true` == OAS
    // `trafficLogs.enabled: false`. Copying the boolean across turns analytics back on for exactly
    // the APIs that asked not to be tracked.
    globalMiddleware.trafficLogs = { enabled: !doNotTrack };
  }

  // An API-wide circuit breaker has no home on `upstream` or `middleware.global` — measured against
  // the v5.15.0 schema, `circuitBreaker` exists ONLY on `X-Tyk-Operation`. So an API-level breaker
  // is expressed the same way the classic mapper expresses it: one catch-all entry per method,
  // here as a synthesised OAS operation rather than an `extended_paths` regex. Without this an OAS
  // api would silently have no breaker while a CLASSIC one did.
  // Middleware Tyk only offers PER OPERATION, expressed API-wide through one synthesised catch-all
  // path. `circuitBreaker`, `urlRewrite`, `mockResponse` and the body transforms all live on
  // `X-Tyk-Operation` and have no `upstream`/`global` equivalent, so without this an OAS api would
  // silently lose them while a CLASSIC one kept them.
  const perOperation: Record<string, unknown> = {};
  if (circuitBreaker) {
    perOperation.circuitBreaker = {
      enabled: true,
      threshold: circuitBreaker.threshold,
      sampleSize: circuitBreaker.sampleSize,
      coolDownPeriod: circuitBreaker.coolDownSeconds,
      halfOpenStateEnabled: true,
    };
  }
  if (urlRewrite) {
    perOperation.urlRewrite = { enabled: true, pattern: urlRewrite.pattern, rewriteTo: urlRewrite.rewriteTo };
  }
  if (mock) {
    perOperation.mockResponse = {
      enabled: true,
      code: mock.code,
      body: mock.body,
      ...(mock.headers ? { headers: mock.headers.map((h) => ({ name: h.name, value: h.value })) } : {}),
    };
  }
  if (transformRequestBody) {
    perOperation.transformRequestBody = {
      enabled: true,
      format: transformRequestBody.format,
      body: transformRequestBody.body,
    };
  }
  if (validateRequestSchema) {
    // Tyk validates against the OAS `requestBody` schema on the operation, so the schema has to be
    // published in the document itself — see the catch-all path builder below, which attaches it.
    perOperation.validateRequest = { enabled: true, errorResponseCode: 422 };
  }
  if (transformResponseBody) {
    perOperation.transformResponseBody = {
      enabled: true,
      format: transformResponseBody.format,
      body: transformResponseBody.body,
    };
  }

  const operations: Record<string, unknown> = {};
  const catchAllPaths: Record<string, unknown> = {};
  if (Object.keys(perOperation).length > 0) {
    const pathItem: Record<string, unknown> = {
      parameters: [{ name: 'wildcard', in: 'path', required: true, schema: { type: 'string' } }],
    };
    for (const method of CATCH_ALL_METHODS) {
      const operationId = catchAllOperationId(method);
      pathItem[method.toLowerCase()] = {
        operationId,
        responses: { '200': { description: 'ok' } },
        ...(validateRequestSchema
          ? { requestBody: { required: true, content: { 'application/json': { schema: validateRequestSchema } } } }
          : {}),
      };
      operations[operationId] = { ...perOperation };
    }
    catchAllPaths[CATCH_ALL_PATH] = pathItem;
  }

  return {
    openapi: '3.0.3',
    info: { title: apiDef.name, version: '1.0.0' },
    // Empty unless an API-wide middleware needs a catch-all operation to hang off: this product
    // proxies whole upstreams rather than describing per-endpoint contracts.
    paths: catchAllPaths,
    ...(authenticated ? { components: { securitySchemes: componentSchemes }, security } : {}),
    'x-tyk-api-gateway': {
      info: {
        id: apiDef.tykApiId ?? `og-${apiDef.id}`,
        name: apiDef.name,
        orgId: tenant.tykOrgId,
        // classic `active` -> `info.state.active`
        state: { active: apiDef.status === ApiStatus.ACTIVE },
        // S6 caveat 4: `version_data.not_versioned` has NO OAS equivalent. `X-Tyk-Versioning`
        // requires a `location` and models real versioning, so an unversioned API omits
        // `info.versioning` entirely rather than emitting a placeholder.
        //
        // WP16: only the DEFAULT of a family with at least one active child gets this block. A
        // CHILD version def never has its own `info.versioning` — live-verified against v5.15.0
        // that the gateway rejects one (`location is required`) the moment ANY field is set on it,
        // even `{enabled:true, name:'v2'}` alone, and routing only ever consults the default's.
        // `versions` is an ARRAY of `{name, id}` on this Tyk version, not the map the docs/most
        // examples show — confirmed against the live schema (`X-Tyk-VersionToID` in the gateway's
        // embedded OAS schema), and POSTing a map answers 400
        // "Invalid type. Expected: array, given: object".
        ...(apiDef.parentApiId === null && apiDef.versionName !== null && versions.length > 0
          ? {
              versioning: {
                enabled: true,
                name: apiDef.versionName,
                default: apiDef.versionName,
                location: 'header',
                key: VERSION_HEADER,
                versions: versions.map((v) => ({ name: v.versionName, id: v.tykApiId })),
              },
            }
          : {}),
      },
      upstream: {
        url: apiDef.proxyUrl,
        ...(rateLimit
          ? {
              rateLimit: {
                // S6 caveat 2: POLARITY INVERTS AGAIN. Classic has `disabled`; OAS has `enabled`,
                // and there is no `disabled` field to fall back on.
                enabled: rateLimit.rate !== 0,
                rate: rateLimit.rate,
                per: rateLimitPer(rateLimit.per),
              },
            }
          : {}),
        ...(timeoutSeconds
          ? { enforceTimeout: { enabled: true, duration: `${String(timeoutSeconds)}s` } }
          : {}),
        ...(loadBalancing && loadBalancing.targets.length > 0
          ? {
              loadBalancing: {
                enabled: true,
                ...(loadBalancing.skipUnavailableHosts === undefined
                  ? {}
                  : { skipUnavailableHosts: loadBalancing.skipUnavailableHosts }),
                targets: loadBalancing.targets.map((t) => ({ url: t.url, weight: t.weight })),
              },
            }
          : {}),
        ...(uptimeTests && uptimeTests.length > 0
          ? {
              uptimeTests: {
                enabled: true,
                tests: uptimeTests.map((t) => ({
                  url: t.url,
                  method: t.method ?? 'GET',
                  ...(t.timeoutSeconds === undefined ? {} : { timeout: `${String(t.timeoutSeconds)}s` }),
                })),
              },
            }
          : {}),
      },
      server: {
        listenPath: { value: gatewayListenPath(tenant.slug, apiDef.listenPath), strip: true },
        // classic `use_keyless` is the inverse of this flag; a keyless API sets it false.
        authentication: authenticated ? { enabled: true, securitySchemes } : { enabled: false },
        // O9: off unless this API opts in. `X-Tyk-DetailedActivityLogs` hangs off `server`, NOT off
        // `middleware.global.trafficLogs` — trafficLogs is whether to record at all, this is how
        // much. Detailed records carry request and response bodies, which is why it is per-API.
        ...(detailedRecording === undefined ? {} : { detailedActivityLogs: { enabled: detailedRecording } }),
        ...(ipAccessControl
          ? {
              ipAccessControl: {
                enabled: true,
                ...(ipAccessControl.allow ? { allow: ipAccessControl.allow } : {}),
                ...(ipAccessControl.block ? { block: ipAccessControl.block } : {}),
              },
            }
          : {}),
      },
      ...(Object.keys(globalMiddleware).length > 0 || Object.keys(operations).length > 0
        ? {
            middleware: {
              ...(Object.keys(globalMiddleware).length > 0 ? { global: globalMiddleware } : {}),
              ...(Object.keys(operations).length > 0 ? { operations } : {}),
            },
          }
        : {}),
    },
  };
}
