import 'reflect-metadata';
import type { ApiDefinition } from '@prisma/client';
import { mapToTykFormat } from './api.service';

// api.service imports the shared prisma singleton; the mapper is pure, so keep the real client out.
jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const CONFIG_KEYS = ['global_rate_limit', 'CORS', 'do_not_track'];

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
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const cors = {
  enable: true,
  allowedOrigins: ['http://localhost:33000'],
  allowedMethods: ['GET', 'POST'],
  allowedHeaders: ['Authorization'],
  exposedHeaders: ['X-Request-Id'],
  allowCredentials: true,
  maxAge: 24,
};

describe('mapToTykFormat', () => {
  it('emits none of the config-driven keys when there is no config', () => {
    for (const config of [null, {}, [], 'text']) {
      const out = mapToTykFormat(apiDef({ config }));
      for (const key of CONFIG_KEYS) expect(out).not.toHaveProperty(key);
    }
  });

  it('keeps the existing fields exactly as before', () => {
    expect(mapToTykFormat(apiDef())).toEqual({
      name: 'Orders',
      api_id: 'og-a1',
      org_id: process.env.TYK_ORG_ID ?? '',
      proxy: { listen_path: '/orders/', target_url: 'http://orders:4000', strip_listen_path: true },
      version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
      use_keyless: false,
      use_standard_auth: true,
      enable_jwt: false,
      auth: { auth_header_name: 'Authorization' },
      active: true,
    });
  });

  it('pins the signing key and the client_id policy claim for an OAUTH api', () => {
    const out = mapToTykFormat(apiDef({ authType: 'OAUTH' }), 'BASE64-PEM');

    expect(out).toMatchObject({
      use_keyless: false,
      use_standard_auth: false,
      enable_jwt: true,
      jwt_signing_method: 'rsa',
      // A base64 PEM, not a JWKS URL: v5.15.0 serves a URL for one request then 403s (see
      // hydra-signing-key.ts), and jwt_jwks_uris applies to OAS definitions only.
      jwt_source: 'BASE64-PEM',
      jwt_identity_base_field: 'sub',
      // A string claim: Tyk cannot resolve a policy from an array-valued claim.
      jwt_policy_field_name: 'client_id',
      // Empty on purpose: a token with no matching policy must be denied, not defaulted.
      jwt_default_policies: [],
    });
    // Tyk's own OAuth2 provider stays off — Hydra is the authorization server.
    expect(out).not.toHaveProperty('use_oauth2');
  });

  it('the mapper alone still cannot make an unconfigured JWT api work — ApiService.create/update refuse to persist this combination (O3)', () => {
    const out = mapToTykFormat(apiDef({ authType: 'JWT' }));

    expect(out.enable_jwt).toBe(true);
    expect(out).not.toHaveProperty('jwt_source');
    expect(out).not.toHaveProperty('jwt_default_policies');
  });

  it('wires bring-your-own JWKS (O3) for a JWT api with a jwt config', () => {
    const out = mapToTykFormat(
      apiDef({
        id: 'a1',
        authType: 'JWT',
        config: {
          jwt: { jwksUrl: 'https://idp.example.com/jwks.json', issuer: 'https://idp.example.com/', identityField: 'email' },
        },
      }),
    );

    expect(out).toMatchObject({
      enable_jwt: true,
      jwt_signing_method: 'rsa',
      jwt_source: 'https://idp.example.com/jwks.json',
      jwt_identity_base_field: 'email',
      // Every token that verifies against jwksUrl gets this one policy — there is no per-subject
      // claim mapping (unlike OAuth's jwt_policy_field_name: 'client_id').
      jwt_default_policies: ['og-jwt-a1'],
    });
    expect(out).not.toHaveProperty('jwt_policy_field_name');
  });

  it('defaults identityField to sub when not set', () => {
    const out = mapToTykFormat(
      apiDef({
        authType: 'JWT',
        config: { jwt: { jwksUrl: 'https://idp.example.com/jwks.json', issuer: 'https://idp.example.com/' } },
      }),
    );
    expect(out.jwt_identity_base_field).toBe('sub');
  });

  it('reuses the stored tykApiId as api_id and maps status to active', () => {
    const out = mapToTykFormat(apiDef({ tykApiId: 'gw-123', status: 'DISABLED' }));
    expect(out.api_id).toBe('gw-123');
    expect(out.active).toBe(false);
  });

  it('maps rateLimit to global_rate_limit', () => {
    const out = mapToTykFormat(apiDef({ config: { rateLimit: { rate: 100, per: 60 } } }));
    expect(out.global_rate_limit).toEqual({ rate: 100, per: 60, disabled: false });
  });

  it('marks the limit disabled when rate is 0', () => {
    const out = mapToTykFormat(apiDef({ config: { rateLimit: { rate: 0, per: 60 } } }));
    expect(out.global_rate_limit).toEqual({ rate: 0, per: 60, disabled: true });
  });

  it('maps cors to the upper-case CORS object', () => {
    const out = mapToTykFormat(apiDef({ config: { cors } }));
    expect(out).not.toHaveProperty('cors');
    expect(out.CORS).toEqual({
      enable: true,
      allowed_origins: ['http://localhost:33000'],
      allowed_methods: ['GET', 'POST'],
      allowed_headers: ['Authorization'],
      exposed_headers: ['X-Request-Id'],
      allow_credentials: true,
      max_age: 24,
      options_passthrough: false,
      debug: false,
    });
  });

  it.each([true, false])('maps doNotTrack=%s to do_not_track', (doNotTrack) => {
    expect(mapToTykFormat(apiDef({ config: { doNotTrack } })).do_not_track).toBe(doNotTrack);
  });

  it('omits sections that were cleared with null', () => {
    const out = mapToTykFormat(apiDef({ config: { rateLimit: null, cors: null } }));
    expect(out).not.toHaveProperty('global_rate_limit');
    expect(out).not.toHaveProperty('CORS');
  });

  it('leaves every non-config field untouched when config is present', () => {
    const withConfig = mapToTykFormat(
      apiDef({ config: { rateLimit: { rate: 5, per: 1 }, cors, doNotTrack: true } }),
    );
    for (const key of CONFIG_KEYS) expect(withConfig).toHaveProperty(key);
    const rest = Object.fromEntries(Object.entries(withConfig).filter(([key]) => !CONFIG_KEYS.includes(key)));
    expect(rest).toEqual(mapToTykFormat(apiDef()));
  });
});
