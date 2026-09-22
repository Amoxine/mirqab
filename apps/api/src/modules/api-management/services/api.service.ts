import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiDefFormat,
  ApiKeyStatus,
  ApiStatus,
  ApiSyncStatus,
  Prisma,
  type ApiAuthType,
  type ApiDefinition,
  type ApiHealthStatus,
} from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { CreateApiDto } from '../dto/create-api.dto';
import { UpdateApiDto } from '../dto/update-api.dto';
import { CreateApiVersionDto } from '../dto/create-api-version.dto';
import type { ApiConfig, ApiConfigDto } from '../dto/api-config.dto';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { OAuthClientService } from '../../oauth-clients/services/oauth-client.service';
import { fetchAccessTokenSigningKey } from './hydra-signing-key';
import { CircuitBreakerOpenError } from '../../../common/circuit-breaker/circuit-breaker.types';
import { loadTenantScope, type TenantGatewayScope } from '../../tyk-integration/services/tenant-scope';
import type { NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { ReconcileService, type SyncState } from './reconcile.service';

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

/** Response shape of every `/apis` route (spec §5.2). `keyCount` counts ACTIVE keys only. */
export interface ApiDetail {
  id: string;
  name: string;
  slug: string;
  proxyUrl: string;
  listenPath: string;
  authType: ApiAuthType;
  status: ApiStatus;
  tykApiId: string | null;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
  lastSyncedAt: Date | null;
  healthStatus: ApiHealthStatus;
  config: ApiConfig;
  keyCount: number;
  /** WP16: null on a plain API and on a family's default; set on a child, pointing at its default. */
  parentApiId: string | null;
  /** WP16: this row's own version name, or null if it has never been part of a version family. */
  versionName: string | null;
  /** WP16: when this (non-default) version was retired. `GET /apis/:id` answers 410 + `Sunset` once set. */
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A retired API version (WP16): deliberately, permanently gone — 410, not 404 — with an RFC 8594
 * `Sunset` header carrying when. `AllExceptionsFilter` adds that header itself, duck-typed off
 * `sunsetAt` alone (common/ shouldn't import a feature module's exception class).
 *
 * Not Tyk's own `info.expiration`: live-verified against v5.15.0 that an expired version answers
 * 403 "API has expired, please check documentation or contact administrator" with no `Sunset`
 * header at all — not this product's contract. This is purely our management API's own answer to
 * `GET /apis/:id` on a retired row; the gateway's data-plane behaviour for a retired version is
 * separate (its sibling entry drops out of `info.versioning` on the next sync — see `mapToTykOas`).
 */
export class RetiredVersionException extends GoneException {
  constructor(
    readonly sunsetAt: Date,
    name: string,
  ) {
    super(`API version "${name}" was retired and is no longer available.`);
  }
}

const SYNC_ERROR_MAX = 500;
const MAX_PAGE_SIZE = 100;

const withActiveKeyCount = {
  _count: { select: { apiKeys: { where: { status: ApiKeyStatus.ACTIVE } } } },
} satisfies Prisma.ApiDefinitionInclude;

type ApiRow = Prisma.ApiDefinitionGetPayload<{ include: typeof withActiveKeyCount }>;

/** `ApiDefinition.config` is free-form JSON in the schema; anything that is not an object reads as empty. */
function readConfig(value: Prisma.JsonValue | null): ApiConfig {
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

/**
 * A version row's own `listenPath` (WP16). Never routed to directly: traffic reaches a version only
 * through the DEFAULT's listen path plus the `x-api-version` header (see `mapToTykOas`'s
 * `info.versioning`). It exists purely because every Tyk OAS definition — including a version's, its
 * own full definition — needs a `server.listenPath.value`, and `api_definitions` needs it unique
 * within the tenant (`@@unique([tenantId, listenPath])`).
 */
const versionListenPath = (parentListenPath: string, versionName: string): string =>
  `${parentListenPath.replace(/\/$/, '')}/__version-${versionName}`;

/** This family's own name for the default/base version, applied the moment its first child is created. */
export const DEFAULT_VERSION_NAME = 'v1';

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

/** DTO instance -> plain JSON. Class fields are own `undefined` properties (ES2022 define semantics); dropping them keeps a merge from wiping stored values. */
function toJsonObject(config: ApiConfigDto): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(config)) as Prisma.InputJsonObject;
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
  const { rateLimit, cors, doNotTrack, jwt, throttle, timeoutSeconds, circuitBreaker, requestSizeLimitBytes, loadBalancing, uptimeTests } =
    readConfig(apiDef.config);

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
    auth: { auth_header_name: 'Authorization' },
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
const SCHEME_NAME = { token: 'authToken', jwt: 'jwtAuth' } as const;

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
  const { rateLimit, cors, doNotTrack, jwt, timeoutSeconds, requestSizeLimitBytes, loadBalancing, uptimeTests, circuitBreaker } =
    readConfig(apiDef.config);
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
      // one global setting).
      header: { enabled: true, name: 'Authorization' },
    };
    componentSchemes[SCHEME_NAME.token] = { type: 'apiKey', in: 'header', name: 'Authorization' };
    security.push({ [SCHEME_NAME.token]: [] });
  }

  if (isOAuth || isJwt) {
    securitySchemes[SCHEME_NAME.jwt] = {
      enabled: true,
      header: { enabled: true, name: 'Authorization' },
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
  const operations: Record<string, unknown> = {};
  const catchAllPaths: Record<string, unknown> = {};
  if (circuitBreaker) {
    const pathItem: Record<string, unknown> = {
      parameters: [{ name: 'wildcard', in: 'path', required: true, schema: { type: 'string' } }],
    };
    for (const method of CATCH_ALL_METHODS) {
      const operationId = catchAllOperationId(method);
      pathItem[method.toLowerCase()] = { operationId, responses: { '200': { description: 'ok' } } };
      operations[operationId] = {
        circuitBreaker: {
          enabled: true,
          threshold: circuitBreaker.threshold,
          sampleSize: circuitBreaker.sampleSize,
          coolDownPeriod: circuitBreaker.coolDownSeconds,
          halfOpenStateEnabled: true,
        },
      };
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

/**
 * Message stored in `syncError` and returned to the UI. `TykClientService` already turns gateway
 * error bodies into sanitised `HttpException`s; anything else (fetch/network errors) may carry
 * hostnames or ports, so it collapses to a fixed string.
 */
export function toSyncError(err: unknown): string {
  let message = 'Gateway unreachable';
  if (err instanceof HttpException) {
    message = err.message;
  } else if (err instanceof CircuitBreakerOpenError) {
    message = 'Gateway temporarily unavailable, retry shortly';
  }
  return message.slice(0, SYNC_ERROR_MAX);
}

/**
 * Listen paths are unique **within a tenant** (O10): the gateway sees `/{tenantSlug}{listenPath}`,
 * so another tenant holding the same path is not a clash and must not be reported as one. The
 * message can therefore name the path — it can only ever be this tenant's own.
 * Prefix overlaps (`/a/` next to `/a/b/`) are allowed: Tyk routes by longest match.
 */
const listenPathTaken = (listenPath: string): string =>
  `Listen path "${listenPath}" is already used by another API in this tenant.`;

const slugTaken = (slug: string): string => `API with slug "${slug}" already exists in this tenant`;

/**
 * A unique violation that slipped past the pre-checks (two concurrent requests) still has to answer
 * 409, not 500. Anything else is returned unchanged for the caller to rethrow.
 */
function asConflict(err: unknown, slug: string | undefined, listenPath: string | undefined): unknown {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return err;
  }
  // `meta.target` is free-form JSON (a string or a list of columns, depending on the driver).
  const fields = JSON.stringify(err.meta?.target ?? '');

  return fields.includes('listen_path')
    ? new ConflictException(listenPathTaken(listenPath ?? ''))
    : new ConflictException(slugTaken(slug ?? ''));
}

function toApiDetail(row: ApiRow): ApiDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    proxyUrl: row.proxyUrl,
    listenPath: row.listenPath,
    authType: row.authType,
    status: row.status,
    tykApiId: row.tykApiId,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: row.lastSyncedAt,
    healthStatus: row.healthStatus,
    config: readConfig(row.config),
    keyCount: row._count.apiKeys,
    parentApiId: row.parentApiId,
    versionName: row.versionName,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);

  constructor(
    private readonly tykClient: TykClientService,
    private readonly oauthClients: OAuthClientService,
    private readonly reconcile: ReconcileService,
  ) {}

  async create(dto: CreateApiDto, tenantId: string): Promise<ApiDetail> {
    // Check slug uniqueness within tenant
    const existing = await prisma.apiDefinition.findUnique({
      where: { tenantId_slug: { tenantId, slug: dto.slug } },
    });

    if (existing) {
      throw new ConflictException(slugTaken(dto.slug));
    }

    // O3: an unconditional `enable_jwt` with no source/policy is the bug this DTO section fixes —
    // never let that combination reach the gateway again.
    if (dto.authType === 'JWT' && !dto.config?.jwt) {
      throw new BadRequestException('authType "JWT" requires config.jwt: { jwksUrl, issuer }');
    }

    await this.assertListenPathFree(dto.listenPath, tenantId);

    // Create in our database
    let apiDef: ApiRow;
    try {
      apiDef = await prisma.apiDefinition.create({
        data: {
          tenantId,
          name: dto.name,
          slug: dto.slug,
          proxyUrl: dto.proxyUrl,
          listenPath: dto.listenPath,
          authType: dto.authType,
          config: dto.config ? toJsonObject(dto.config) : {},
          status: ApiStatus.DRAFT,
          syncStatus: ApiSyncStatus.PENDING,
        },
        include: withActiveKeyCount,
      });
    } catch (err) {
      throw asConflict(err, dto.slug, dto.listenPath);
    }

    // Sync to Tyk (fire and forget — background sync)
    this.syncInBackground(apiDef);

    return toApiDetail(apiDef);
  }

  /**
   * `POST /apis/:id/versions` (WP16): a genuinely separate OAS definition — its own `proxyUrl`,
   * auth, config — selected by clients sending `x-api-version: <versionName>` to the DEFAULT's
   * listen path. `slug` and `listenPath` are derived rather than user-supplied: nothing routes to
   * a version's own listen path directly (`versionListenPath`), so asking a caller to invent one
   * would only invite a value nobody ever uses.
   *
   * Awaits the child's own sync before returning: the default's next sync needs the child's
   * `tykApiId` to put in `info.versioning.versions`, so the child has to exist on the gateway first.
   */
  async createVersion(id: string, dto: CreateApiVersionDto, tenantId: string): Promise<ApiDetail> {
    const parent = await this.findRow(id, tenantId);

    if (parent.parentApiId !== null) {
      throw new BadRequestException('Cannot create a version of a version; create it on the default API.');
    }
    if (parent.defFormat !== ApiDefFormat.OAS) {
      throw new BadRequestException('API versioning requires the OAS format; this API is CLASSIC.');
    }
    // O3, same guard as `create`/`update`.
    if (dto.authType === 'JWT' && !dto.config?.jwt) {
      throw new BadRequestException('authType "JWT" requires config.jwt: { jwksUrl, issuer }');
    }

    const childListenPath = versionListenPath(parent.listenPath, dto.versionName);
    const childSlug = `${parent.slug}-${dto.versionName}`;

    let child: ApiRow;
    try {
      child = await prisma.apiDefinition.create({
        data: {
          tenantId,
          parentApiId: parent.id,
          versionName: dto.versionName,
          name: `${parent.name} (${dto.versionName})`,
          slug: childSlug,
          proxyUrl: dto.proxyUrl,
          listenPath: childListenPath,
          authType: dto.authType ?? parent.authType,
          config: dto.config ? toJsonObject(dto.config) : {},
          status: ApiStatus.ACTIVE,
          defFormat: ApiDefFormat.OAS,
          syncStatus: ApiSyncStatus.PENDING,
        },
        include: withActiveKeyCount,
      });
    } catch (err) {
      // A duplicate `versionName` always produces a duplicate derived slug too (childSlug encodes
      // it), so asConflict's slug-vs-listen-path split already lands on the right message.
      throw asConflict(err, childSlug, childListenPath);
    }

    // The family's own version name is assigned once, on its first child — an API that never gains
    // one keeps it null forever and mapToTykOas keeps omitting `info.versioning` for it.
    if (parent.versionName === null) {
      await prisma.apiDefinition.update({
        where: { id: parent.id },
        data: { versionName: DEFAULT_VERSION_NAME },
      });
    }

    await this.syncToTyk(child);
    await this.resyncParent(parent.id);

    return toApiDetail(await this.findRow(child.id, tenantId));
  }

  async findAll(
    tenantId: string,
    page = 1,
    pageSize = 20,
    status?: ApiStatus,
    syncStatus?: ApiSyncStatus,
    q?: string,
  ): Promise<PaginatedResult<ApiDetail>> {
    const safePage = Math.max(1, page);
    const take = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const where: Prisma.ApiDefinitionWhereInput = { tenantId };

    if (status) {
      where.status = status;
    }
    if (syncStatus) {
      where.syncStatus = syncStatus;
    }
    const term = q?.trim();
    if (term) {
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
        { listenPath: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, totalCount] = await Promise.all([
      prisma.apiDefinition.findMany({
        where,
        skip: (safePage - 1) * take,
        take,
        orderBy: { createdAt: 'desc' },
        include: withActiveKeyCount,
      }),
      prisma.apiDefinition.count({ where }),
    ]);

    return {
      data: rows.map(toApiDetail),
      meta: {
        page: safePage,
        pageSize: take,
        totalCount,
        totalPages: Math.ceil(totalCount / take),
      },
    };
  }

  async findOne(id: string, tenantId: string): Promise<ApiDetail> {
    const row = await this.findRow(id, tenantId);
    // WP16: `update()` always stamps `retiredAt` in the same write that sets RETIRED, so it is
    // never null here in practice — the check just satisfies the type rather than trusting that blind.
    if (row.status === ApiStatus.RETIRED && row.retiredAt) {
      throw new RetiredVersionException(row.retiredAt, row.name);
    }
    return toApiDetail(row);
  }

  async update(id: string, dto: UpdateApiDto, tenantId: string): Promise<ApiDetail> {
    const existing = await this.findRow(id, tenantId);

    // If slug is changing, check uniqueness
    if (dto.slug && dto.slug !== existing.slug) {
      const duplicate = await prisma.apiDefinition.findUnique({
        where: { tenantId_slug: { tenantId, slug: dto.slug } },
      });
      if (duplicate) {
        throw new ConflictException(slugTaken(dto.slug));
      }
    }

    if (dto.listenPath && dto.listenPath !== existing.listenPath) {
      await this.assertListenPathFree(dto.listenPath, tenantId);
    }

    const { config, ...fields } = dto;
    // The change is not on the gateway yet: don't keep reporting the previous SYNCED state.
    const data: Prisma.ApiDefinitionUpdateInput = { ...fields, syncStatus: ApiSyncStatus.PENDING };
    if (config) {
      // Section-level merge: an absent section keeps its stored value, `null` clears it.
      data.config = { ...readConfig(existing.config), ...toJsonObject(config) } as Prisma.InputJsonObject;
    }

    // O3, same guard as `create`: the effective authType after this PATCH — whether just set now or
    // already JWT and merely untouched here — must carry a jwt section, using the SAME merged config
    // `data.config` above just computed (so a PATCH that clears `jwt` while leaving authType: JWT is
    // caught too, not just a bare authType switch with no config at all).
    const effectiveAuthType = dto.authType ?? existing.authType;
    const effectiveConfig = config ? (data.config as Prisma.JsonValue) : existing.config;
    if (effectiveAuthType === 'JWT' && !readConfig(effectiveConfig).jwt) {
      throw new BadRequestException('authType "JWT" requires config.jwt: { jwksUrl, issuer }');
    }

    // WP16: RETIRED is a version-lifecycle state, not a generic one — retiring the default would
    // leave the family's `x-api-version` routing (and every key still pointed at it) with nothing
    // to serve, so only a child can take it. `retiredAt` is this row's Sunset-header timestamp
    // (GET /apis/:id, ApiManagementController.findOne) and is cleared on any move away from RETIRED.
    if (dto.status === ApiStatus.RETIRED) {
      if (existing.parentApiId === null) {
        throw new BadRequestException(
          'Only a non-default version can be retired. Disable or delete the default API instead.',
        );
      }
      data.retiredAt = new Date();
    } else if (dto.status !== undefined && existing.status === ApiStatus.RETIRED) {
      data.retiredAt = null;
    }

    let updated: ApiRow;
    try {
      updated = await prisma.apiDefinition.update({
        where: { id },
        data,
        include: withActiveKeyCount,
      });
    } catch (err) {
      throw asConflict(err, dto.slug, dto.listenPath);
    }

    // Sync changes to Tyk
    this.syncInBackground(updated);

    // WP16: a retire/un-retire also changes what the DEFAULT should be serving — it must drop or
    // re-add this child in `info.versioning.versions` on its own next sync.
    if (existing.parentApiId && dto.status !== undefined) {
      await this.resyncParent(existing.parentApiId);
    }

    return toApiDetail(updated);
  }

  /** Hard delete (D16): refused while ACTIVE keys reference the API; removes the gateway definition first. */
  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const apiDef = await this.findRow(id, tenantId);

    // WP16: the default's `info.versioning` config is what routes every version, and every version
    // row FK-references it (`onDelete: Restrict`, so the database would refuse this anyway) — refuse
    // it here first, with a message that says why, rather than surfacing a raw FK-violation 500.
    if (apiDef.parentApiId === null) {
      const versionCount = await prisma.apiDefinition.count({ where: { parentApiId: apiDef.id } });
      if (versionCount > 0) {
        throw new ConflictException(
          `Cannot delete the default version: ${String(versionCount)} version(s) still exist. Delete or retire them first.`,
        );
      }
    }

    if (apiDef._count.apiKeys > 0) {
      throw new ConflictException(
        `Cannot delete API: ${String(apiDef._count.apiKeys)} active key(s) still use it. Revoke them first.`,
      );
    }

    // OAuth2 clients live in Hydra, not in `apiKeys`, so the count above cannot see them. Always
    // check — not just when authType is currently OAUTH — because authType is patchable (UpdateApiDto
    // extends PartialType(CreateApiDto)): flipping it away from OAUTH first would otherwise let this
    // check skip past clients Hydra still holds, stranding credentials the dashboard can no longer
    // list or revoke (findByApi filters by apiDefId, independent of the API's current authType).
    const clients = await this.oauthClients.findByApi(id, tenantId);
    if (clients.length > 0) {
      throw new ConflictException(
        `Cannot delete API: ${String(clients.length)} OAuth2 client(s) still use it. Revoke them first.`,
      );
    }

    if (apiDef.tykApiId) {
      try {
        await this.tykClient.deleteApi(apiDef.tykApiId);
      } catch (err) {
        // Keep the row: deleting it while the definition stays live would orphan a routable API.
        throw new BadGatewayException(`Could not remove the API from the gateway: ${toSyncError(err)}`);
      }
    }

    // Best-effort: the API is already gone from the gateway at this point, so a leftover policy
    // file is a paper cut (`deletePolicy` is idempotent), never a reason to fail the delete.
    if (apiDef.authType === 'JWT') {
      try {
        await this.tykClient.deletePolicy(jwtPolicyId(apiDef.id));
      } catch (err) {
        this.logger.warn(
          `Could not remove JWT policy for deleted API ${apiDef.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await prisma.apiDefinition.delete({ where: { id } });

    // WP16: a deleted child must disappear from the default's `info.versioning.versions` too.
    if (apiDef.parentApiId) {
      await this.resyncParent(apiDef.parentApiId);
    }

    return { message: 'API deleted' };
  }

  /**
   * Awaited sync for `POST /apis/:id/sync`. Never rejects because of the gateway: a failed sync
   * comes back as `syncStatus: 'FAILED'` + `syncError` on the returned record.
   */
  async syncNow(id: string, tenantId: string): Promise<ApiDetail> {
    const apiDef = await this.findRow(id, tenantId);
    return toApiDetail(await this.syncToTyk(apiDef));
  }

  /**
   * Refuse a listen path another API **in this tenant** already owns (O10). Another tenant holding
   * the same path is fine: the gateway routes on `/{tenantSlug}{listenPath}`, so the two cannot
   * collide. The exact stored string is compared — the DTO already enforces the leading slash.
   */
  private async assertListenPathFree(listenPath: string, tenantId: string): Promise<void> {
    const clash = await prisma.apiDefinition.findFirst({
      where: { listenPath, tenantId },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictException(listenPathTaken(listenPath));
    }
  }

  private async findRow(id: string, tenantId: string): Promise<ApiRow> {
    const apiDef = await prisma.apiDefinition.findFirst({
      where: { id, tenantId },
      include: withActiveKeyCount,
    });

    if (!apiDef) {
      throw new NotFoundException('API definition not found');
    }

    return apiDef;
  }

  private syncInBackground(apiDef: ApiDefinition): void {
    // syncToTyk only rejects on a database failure; gateway failures are recorded on the row.
    this.syncToTyk(apiDef).catch((err: unknown) => {
      this.logger.error(
        `Failed to record sync of API ${apiDef.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Re-push a family's default after one of its versions changed (WP16), fire-and-forget like every other sync. */
  private async resyncParent(parentApiId: string): Promise<void> {
    const parent = await prisma.apiDefinition.findUnique({ where: { id: parentApiId } });
    if (parent) this.syncInBackground(parent);
  }

  /**
   * The signing key an OAUTH api pins, re-read on every sync so `POST /apis/:id/sync` is the
   * operator's way to pick up a rotated Hydra key. A failure is a gateway error, so it lands on the
   * row as `syncStatus: FAILED` with a message that says what actually went wrong.
   */
  private async oauthSigningKey(authType: ApiAuthType): Promise<string> {
    if (authType !== 'OAUTH') return '';

    try {
      return await fetchAccessTokenSigningKey(process.env.ORY_HYDRA_ADMIN_URL ?? 'http://hydra:4445');
    } catch (err) {
      throw new BadGatewayException(
        err instanceof Error ? err.message : 'Could not read the OAuth2 signing key',
      );
    }
  }

  /** Push the definition to Tyk and persist the outcome: SYNCED + `lastSyncedAt`, or FAILED + `syncError`. */
  private async syncToTyk(apiDef: ApiDefinition): Promise<ApiRow> {
    return (await this.syncToTykWithNodes(apiDef)).row;
  }

  /**
   * As `syncToTyk`, but also hands back which nodes accepted the write — what `POST /apis/:id/sync`
   * needs to answer 207 rather than a 200 that hides a node having refused it.
   */
  private async syncToTykWithNodes(apiDef: ApiDefinition): Promise<{ row: ApiRow; nodes: NodeOutcome[] }> {
    let tykApiId: string;
    let nodes: NodeOutcome[] = [];

    // Read once here rather than threading a tenant through every caller: the org and slug must be
    // identical across the definition and its JWT policy, and one query per sync is cheaper than the
    // chance of two call sites drifting apart. `tenantId` is a non-null FK, so this always resolves.
    const tenant = await loadTenantScope(apiDef.tenantId);

    let oasDocument: Prisma.InputJsonValue | undefined;

    try {
      const signingKey = await this.oauthSigningKey(apiDef.authType);

      if (apiDef.defFormat === ApiDefFormat.OAS) {
        // WP16: only a default (never a child — see mapToTykOas) can have `info.versioning`, and
        // only when it actually has an active version to route to. RETIRED children are excluded so
        // a retired version drops out of `versions` on the default's very next sync.
        const versions: ApiVersionChild[] =
          apiDef.parentApiId === null
            ? (
                await prisma.apiDefinition.findMany({
                  where: { parentApiId: apiDef.id, status: { not: ApiStatus.RETIRED } },
                  select: { versionName: true, tykApiId: true },
                })
              ).filter(
                (v): v is { versionName: string; tykApiId: string } => v.versionName !== null && v.tykApiId !== null,
              )
            : [];

        // `/tyk/apis/oas` POST is an upsert keyed by the document's own `info.id`, so create and
        // update are the same call — unlike the classic pair, which needs POST then PUT-by-id.
        const oasDef = mapToTykOas(apiDef, tenant, signingKey, versions);
        tykApiId = apiDef.tykApiId ?? `og-${apiDef.id}`;
        nodes = await this.tykClient.upsertOasApi(oasDef);
        // Stored so drift and the UI can show what was actually sent, rather than re-deriving it
        // from a row that may have changed since.
        oasDocument = oasDef as Prisma.InputJsonValue;
      } else if (apiDef.tykApiId) {
        // Update existing
        nodes = (await this.tykClient.updateApi(apiDef.tykApiId, mapToTykFormat(apiDef, tenant, signingKey))).nodes;
        tykApiId = apiDef.tykApiId;
      } else {
        // Create new
        const created = await this.tykClient.createApi(mapToTykFormat(apiDef, tenant, signingKey));
        tykApiId = created.apiId;
        nodes = created.nodes;
      }

      // The def above already points jwt_default_policies at jwtPolicyId(apiDef.id) — that policy
      // itself only becomes resolvable once it exists, and it needs tykApiId (just learned) for its
      // access_rights, so it is written second. Same try/catch as the def write: a policy failure is
      // a sync failure, not a silently-half-authorized API.
      if (apiDef.authType === 'JWT') {
        await this.tykClient.upsertPolicy(buildJwtPolicy(apiDef, tykApiId, tenant.tykOrgId));
      }
    } catch (err) {
      const syncError = toSyncError(err);
      this.logger.warn(`Sync of API ${apiDef.id} failed: ${syncError}`);

      return {
        row: await prisma.apiDefinition.update({
          where: { id: apiDef.id },
          data: { syncStatus: ApiSyncStatus.FAILED, syncError },
          include: withActiveKeyCount,
        }),
        nodes,
      };
    }

    // A partial fan-out is not a clean sync: the definition is live on some nodes and stale on
    // others, so the row says so rather than reporting SYNCED and letting the drift tick discover it
    // a minute later.
    const failed = nodes.filter((n) => !n.ok);
    return {
      row: await prisma.apiDefinition.update({
        where: { id: apiDef.id },
        data: {
          tykApiId,
          ...(oasDocument === undefined ? {} : { oasDocument }),
          syncStatus: failed.length > 0 ? ApiSyncStatus.FAILED : ApiSyncStatus.SYNCED,
          syncError:
            failed.length > 0
              ? `${String(failed.length)} of ${String(nodes.length)} gateway nodes did not accept the definition`
              : null,
          lastSyncedAt: new Date(),
          healthStatus: 'UNKNOWN' as const,
        },
        include: withActiveKeyCount,
      }),
      nodes,
    };
  }

  /**
   * Re-push to every node and report which ones took it. The controller turns a partial result into
   * 207; this returns the facts rather than deciding the status code.
   */
  async syncNowWithNodes(id: string, tenantId: string): Promise<{ detail: ApiDetail; nodes: NodeOutcome[] }> {
    const apiDef = await this.findRow(id, tenantId);
    const { row, nodes } = await this.syncToTykWithNodes(apiDef);
    return { detail: toApiDetail(row), nodes };
  }

  /**
   * Per-node drift for one definition, recomputed on demand so the caller never reads a stale tick.
   * `differences` lists the nodes that disagree with the majority hash (or that could not be read),
   * which is what an operator acts on.
   */
  async drift(
    id: string,
    tenantId: string,
  ): Promise<{ inSync: boolean; differences: string[]; perNode: SyncState['nodes'] }> {
    const apiDef = await this.findRow(id, tenantId);
    if (!apiDef.tykApiId) {
      return { inSync: false, differences: ['never synced to the gateway'], perNode: {} };
    }

    const state = await this.reconcile.reconcileOne(apiDef.id, apiDef.tykApiId, apiDef.defFormat);
    const hashes = Object.values(state.nodes)
      .map((n) => n.hash)
      .filter((h): h is string => h !== null);
    const majority = hashes
      .sort(
        (a, b) => hashes.filter((h) => h === b).length - hashes.filter((h) => h === a).length,
      )
      .at(0);

    const differences = Object.entries(state.nodes)
      .filter(([, view]) => !view.present || view.hash !== majority)
      .map(([nodeUrl, view]) => `${nodeUrl}: ${view.error ?? 'definition differs'}`);

    return { inSync: state.inSync, differences, perNode: state.nodes };
  }
}
