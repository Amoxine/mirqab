import 'reflect-metadata';
import type { ApiDefinition } from '@prisma/client';
import { mapToTykFormat, mapToTykOas } from './tyk-mappers';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const TENANT = { tykOrgId: 'og-t1', slug: 'acme' };

function apiDef(overrides: Partial<ApiDefinition> = {}): ApiDefinition {
  return {
    id: 'a1',
    tenantId: 't1',
    name: 'Orders',
    slug: 'orders',
    tykApiId: null,
    proxyUrl: 'http://orders:4000',
    listenPath: '/orders/',
    authType: 'AUTH_TOKEN',
    status: 'ACTIVE',
    config: null,
    syncStatus: 'PENDING',
    syncError: null,
    syncState: null,
    defFormat: 'OAS',
    parentApiId: null,
    retiredAt: null,
    versionName: null,
    oasDocument: null,
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ApiDefinition;
}

/**
 * The slices of each format this golden file actually asserts on. Spelled out rather than reached
 * for through `any`, so that a field disappearing from either mapper is a COMPILE error here — the
 * whole point of a golden file is to fail when coverage silently drops.
 */
interface JwtScheme {
  enabled: boolean;
  header: { enabled: boolean; name: string };
  signingMethod: string;
  source: string;
  identityBaseField: string;
  policyFieldName?: string;
  defaultPolicies: string[];
}
interface TokenScheme {
  enabled: boolean;
  header: { enabled: boolean; name: string };
}
interface OasDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components?: { securitySchemes: Record<string, unknown> };
  security?: Record<string, string[]>[];
  'x-tyk-api-gateway': {
    info: { id: string; name: string; orgId: string; state: { active: boolean }; versioning?: unknown };
    upstream: { url: string; rateLimit?: { enabled: boolean; rate: number; per: string } };
    server: {
      listenPath: { value: string; strip: boolean };
      authentication: { enabled: boolean; securitySchemes?: Record<string, JwtScheme & TokenScheme> };
    };
    middleware?: { global: { cors?: Record<string, unknown>; trafficLogs?: { enabled: boolean } } };
  };
}
interface ClassicDef {
  name: string;
  api_id: string;
  org_id: string;
  proxy: { listen_path: string; target_url: string; strip_listen_path: boolean };
  version_data?: unknown;
  use_keyless: boolean;
  use_standard_auth: boolean;
  enable_jwt: boolean;
  auth: { auth_header_name: string };
  active: boolean;
  global_rate_limit?: { rate: number; per: number; disabled: boolean };
  CORS?: Record<string, unknown> & { enable: boolean };
  do_not_track?: boolean;
  jwt_signing_method?: string;
  jwt_source?: string;
  jwt_identity_base_field?: string;
  jwt_policy_field_name?: string;
  jwt_default_policies?: string[];
}

const oas = (over: Partial<ApiDefinition> = {}, jwtSource = '', versions: { versionName: string; tykApiId: string }[] = []) =>
  mapToTykOas(apiDef(over), TENANT, jwtSource, versions) as unknown as OasDoc;
const classic = (over: Partial<ApiDefinition> = {}, jwtSource = '') =>
  mapToTykFormat(apiDef(over), TENANT, jwtSource) as unknown as ClassicDef;

/** Named schemes, non-null-asserted once here rather than at twenty call sites. */
const schemes = (d: OasDoc): Record<string, JwtScheme & TokenScheme> =>
  d['x-tyk-api-gateway'].server.authentication.securitySchemes ?? {};

const cors = {
  enable: true,
  allowedOrigins: ['http://localhost:33000'],
  allowedMethods: ['GET', 'POST'],
  allowedHeaders: ['Authorization'],
  exposedHeaders: ['X-Request-Id'],
  allowCredentials: true,
  maxAge: 24,
};

/**
 * WP13b golden file: every named top-level key the CLASSIC mapper emits must have an OAS
 * equivalent, asserted key by key rather than by a whole-document snapshot — a snapshot would go
 * green on a wholesale regeneration and tell us nothing about coverage.
 *
 * Counts, re-verified against the current `mapToTykFormat` rather than taken from the plan:
 *   NONE / AUTH_TOKEN -> 13 named keys
 *   OAUTH             -> 13 + 5 (`jwtFieldsForOAuth`)             = 18
 *   JWT   (O3)        -> 13 + 4 (`jwtFieldsForBringYourOwnJwks`)  = 17
 * The plan documents only the first two; the JWT shape arrived with WP12b's O3 fix and emits no
 * `jwt_policy_field_name`, so 17 is a third shape S6 never saw.
 */
describe('mapToTykOas — golden file against every classic key', () => {
  it('classic emits exactly the 13 named top-level keys this file covers (fully configured)', () => {
    // Guards the checklist itself: a 14th key added to the classic mapper must fail here rather
    // than quietly go unmapped in OAS.
    const keys = Object.keys(classic({ config: { rateLimit: { rate: 10, per: 60 }, cors, doNotTrack: true } }));
    expect(keys.sort()).toEqual(
      [
        'CORS',
        'active',
        'api_id',
        'auth',
        'do_not_track',
        'enable_jwt',
        'global_rate_limit',
        'name',
        'org_id',
        'proxy',
        'use_keyless',
        'use_standard_auth',
        'version_data',
      ].sort(),
    );
    expect(keys).toHaveLength(13);
  });

  it('1. name -> info.title and x-tyk info.name', () => {
    const d = oas();
    expect(d.info.title).toBe('Orders');
    expect(d['x-tyk-api-gateway'].info.name).toBe('Orders');
  });

  it('2. api_id -> x-tyk info.id', () => {
    expect(oas()['x-tyk-api-gateway'].info.id).toBe('og-a1');
    expect(oas({ tykApiId: 'gw-9' })['x-tyk-api-gateway'].info.id).toBe('gw-9');
  });

  it('3. org_id -> x-tyk info.orgId (the tenant org, WP12c)', () => {
    expect(oas()['x-tyk-api-gateway'].info.orgId).toBe('og-t1');
  });

  it('4. proxy.{listen_path,strip_listen_path,target_url} -> listenPath.{value,strip} + upstream.url', () => {
    const x = oas()['x-tyk-api-gateway'];
    expect(x.server.listenPath).toEqual({ value: '/acme/orders/', strip: true });
    expect(x.upstream.url).toBe('http://orders:4000');
    // the tenant-slug prefix is identical in both formats
    expect(x.server.listenPath.value).toBe(classic().proxy.listen_path);
  });

  it('5. version_data has NO OAS equivalent — info.versioning is omitted, not faked (S6 caveat 4)', () => {
    expect(classic()).toHaveProperty('version_data');
    expect(oas()['x-tyk-api-gateway'].info).not.toHaveProperty('versioning');
  });

  it('6. use_keyless -> authentication.enabled, inverted', () => {
    expect(classic({ authType: 'NONE' }).use_keyless).toBe(true);
    expect(oas({ authType: 'NONE' })['x-tyk-api-gateway'].server.authentication).toEqual({ enabled: false });
  });

  it('7. use_standard_auth -> a token securityScheme, declared in BOTH required places', () => {
    const d = oas({ authType: 'AUTH_TOKEN' });
    expect(classic({ authType: 'AUTH_TOKEN' }).use_standard_auth).toBe(true);
    expect(schemes(d).authToken.enabled).toBe(true);
    // S6 structural caveat: the OAS component and the root `security` entry are BOTH required.
    expect(d.components?.securitySchemes.authToken).toEqual({ type: 'apiKey', in: 'header', name: 'Authorization' });
    expect(d.security).toEqual([{ authToken: [] }]);
  });

  it('8. enable_jwt -> a jwt securityScheme for both OAUTH and JWT', () => {
    for (const authType of ['OAUTH', 'JWT'] as const) {
      const over = authType === 'JWT' ? { authType, config: { jwt: { jwksUrl: 'https://idp/.well-known/jwks.json' } } } : { authType };
      expect(classic(over).enable_jwt).toBe(true);
      expect(schemes(oas(over)).jwtAuth.enabled).toBe(true);
    }
  });

  it('9. auth.auth_header_name -> per-scheme header.name (per scheme in OAS, global in classic)', () => {
    expect(classic().auth).toEqual({ auth_header_name: 'Authorization' });
    expect(schemes(oas()).authToken.header).toEqual({
      enabled: true,
      name: 'Authorization',
    });
  });

  it('10. active -> info.state.active', () => {
    expect(oas({ status: 'ACTIVE' })['x-tyk-api-gateway'].info.state.active).toBe(true);
    expect(oas({ status: 'DISABLED' })['x-tyk-api-gateway'].info.state.active).toBe(false);
  });

  it('11. global_rate_limit -> upstream.rateLimit, with per as a STRING and polarity INVERTED', () => {
    const c = classic({ config: { rateLimit: { rate: 10, per: 60 } } });
    const x = oas({ config: { rateLimit: { rate: 10, per: 60 } } })['x-tyk-api-gateway'];

    expect(c.global_rate_limit).toEqual({ rate: 10, per: 60, disabled: false });
    // S6 caveat 1: `per` is seconds-as-number classically, duration-STRING in OAS.
    // S6 caveat 2: classic `disabled` becomes OAS `enabled` — there is no `disabled` field.
    expect(x.upstream.rateLimit).toEqual({ enabled: true, rate: 10, per: '60s' });
    expect(typeof x.upstream.rateLimit?.per).toBe('string');
  });

  it('11b. rate 0 means unlimited: classic disabled:true == OAS enabled:false', () => {
    expect(classic({ config: { rateLimit: { rate: 0, per: 60 } } }).global_rate_limit?.disabled).toBe(true);
    expect(oas({ config: { rateLimit: { rate: 0, per: 60 } } })['x-tyk-api-gateway'].upstream.rateLimit?.enabled).toBe(
      false,
    );
  });

  it('12. CORS -> middleware.global.cors, all nine fields', () => {
    const c = classic({ config: { cors } }).CORS as Record<string, unknown> & { enable: boolean };
    const x = oas({ config: { cors } })['x-tyk-api-gateway'].middleware?.global.cors ?? {};

    expect(x).toEqual({
      enabled: c.enable,
      allowedOrigins: c.allowed_origins,
      allowedMethods: c.allowed_methods,
      allowedHeaders: c.allowed_headers,
      exposedHeaders: c.exposed_headers,
      allowCredentials: c.allow_credentials,
      maxAge: c.max_age,
      optionsPassthrough: c.options_passthrough,
      debug: c.debug,
    });
    expect(Object.keys(x)).toHaveLength(9);
  });

  it('13. do_not_track -> trafficLogs.enabled, INVERTED (S6 caveat 3)', () => {
    expect(classic({ config: { doNotTrack: true } }).do_not_track).toBe(true);
    expect(oas({ config: { doNotTrack: true } })['x-tyk-api-gateway'].middleware?.global.trafficLogs).toEqual({
      enabled: false,
    });
    expect(oas({ config: { doNotTrack: false } })['x-tyk-api-gateway'].middleware?.global.trafficLogs).toEqual({
      enabled: true,
    });
  });

  describe('the 5 OAUTH-only fields (18 keys total classically)', () => {
    // Full config: the three conditional keys (global_rate_limit, CORS, do_not_track) are only
    // emitted when their config section exists, so "13 named" and "18 for OAUTH" are counts for a
    // fully-configured API. Without config the same API emits 10 and 15.
    const over = { authType: 'OAUTH' as const, config: { rateLimit: { rate: 10, per: 60 }, cors, doNotTrack: true } };
    const scheme = () => schemes(oas(over, 'BASE64-PEM')).jwtAuth;

    it('classic emits 18 keys for OAUTH', () => {
      expect(Object.keys(classic(over, 'BASE64-PEM'))).toHaveLength(18);
    });

    it('14-18. signing method, source, identity field, policy field and default policies', () => {
      const c = classic(over, 'BASE64-PEM');
      const s = scheme();
      expect(c.jwt_signing_method).toBe('rsa');
      expect(s.signingMethod).toBe('rsa');
      expect(c.jwt_source).toBe('BASE64-PEM');
      expect(s.source).toBe('BASE64-PEM');
      expect(c.jwt_identity_base_field).toBe('sub');
      expect(s.identityBaseField).toBe('sub');
      expect(c.jwt_policy_field_name).toBe('client_id');
      expect(s.policyFieldName).toBe('client_id');
      expect(c.jwt_default_policies).toEqual([]);
      expect(s.defaultPolicies).toEqual([]);
    });
  });

  describe('the JWT (O3) shape — 17 keys, a third shape S6 never saw', () => {
    const over = {
      authType: 'JWT' as const,
      config: {
        jwt: { jwksUrl: 'https://idp/.well-known/jwks.json' },
        rateLimit: { rate: 10, per: 60 },
        cors,
        doNotTrack: true,
      },
    };
    const scheme = () => schemes(oas(over)).jwtAuth;

    it('classic emits 17 keys, NOT 18 — no jwt_policy_field_name', () => {
      const keys = Object.keys(classic(over));
      expect(keys).toHaveLength(17);
      expect(keys).not.toContain('jwt_policy_field_name');
    });

    it('maps the JWKS url through `source`, and OAS omits policyFieldName to match', () => {
      expect(classic(over).jwt_source).toBe('https://idp/.well-known/jwks.json');
      expect(scheme().source).toBe('https://idp/.well-known/jwks.json');
      expect(scheme()).not.toHaveProperty('policyFieldName');
    });

    it('carries the one default policy every valid token maps to', () => {
      expect(classic(over).jwt_default_policies).toEqual(['og-jwt-a1']);
      expect(scheme().defaultPolicies).toEqual(['og-jwt-a1']);
    });

    it('honours a custom identity field', () => {
      const custom = { authType: 'JWT' as const, config: { jwt: { jwksUrl: 'https://i/j', identityField: 'email' } } };
      expect(classic(custom).jwt_identity_base_field).toBe('email');
      expect(schemes(oas(custom)).jwtAuth.identityBaseField).toBe(
        'email',
      );
    });
  });

  describe('document shape', () => {
    it('is a valid-looking OAS 3.0.3 document with the Tyk extension', () => {
      const d = oas();
      expect(d.openapi).toBe('3.0.3');
      expect(d.info.title).toBe('Orders');
      expect(typeof d.info.version).toBe('string');
      expect(d.paths).toEqual({});
      expect(d['x-tyk-api-gateway'].info).toBeDefined();
      expect(d['x-tyk-api-gateway'].upstream).toBeDefined();
      expect(d['x-tyk-api-gateway'].server).toBeDefined();
    });

    it('omits components/security entirely for a keyless api rather than emitting empty ones', () => {
      const d = oas({ authType: 'NONE' });
      expect(d).not.toHaveProperty('components');
      expect(d).not.toHaveProperty('security');
    });

    it('omits middleware when there is no cors and no doNotTrack', () => {
      expect(oas()['x-tyk-api-gateway']).not.toHaveProperty('middleware');
    });

    it('leaves the classic mapper untouched — both formats stay correct side by side', () => {
      // WP13b is additive: CLASSIC rows keep being served from the classic definition.
      expect(classic()).toMatchObject({ name: 'Orders', api_id: 'og-a1', org_id: 'og-t1' });
    });
  });

  describe('versioning (WP16)', () => {
    it('omits info.versioning for a plain, never-versioned API — regression guard for the classic ' +
      '"Version information not found" 403: an OAS def has no `version_data` equivalent, so the fix ' +
      'is to omit the block entirely rather than emit a broken placeholder', () => {
      expect(oas()['x-tyk-api-gateway'].info).not.toHaveProperty('versioning');
    });

    it('omits info.versioning for a child version even if (mistakenly) passed sibling data', () => {
      const d = oas({ parentApiId: 'default-1', versionName: 'v2' }, '', [
        { versionName: 'v3', tykApiId: 'og-v3' },
      ]);
      expect(d['x-tyk-api-gateway'].info).not.toHaveProperty('versioning');
    });

    it('omits info.versioning for a default with a versionName but no active children yet', () => {
      const d = oas({ parentApiId: null, versionName: 'v1' });
      expect(d['x-tyk-api-gateway'].info).not.toHaveProperty('versioning');
    });

    it('emits info.versioning on a default with active children — versions is an ARRAY of {name,id}, ' +
      'not a map (live-verified against v5.15.0: POSTing a map answers 400 "Invalid type. Expected: ' +
      'array, given: object")', () => {
      const d = oas({ parentApiId: null, versionName: 'v1' }, '', [
        { versionName: 'v2', tykApiId: 'og-v2' },
        { versionName: 'v3', tykApiId: 'og-v3' },
      ]);
      expect(d['x-tyk-api-gateway'].info.versioning).toEqual({
        enabled: true,
        name: 'v1',
        default: 'v1',
        location: 'header',
        key: 'x-api-version',
        versions: [
          { name: 'v2', id: 'og-v2' },
          { name: 'v3', id: 'og-v3' },
        ],
      });
    });
  });
});
