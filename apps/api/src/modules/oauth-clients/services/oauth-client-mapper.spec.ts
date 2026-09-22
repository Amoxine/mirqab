import { BadRequestException } from '@nestjs/common';
import { QuotaPeriod } from '@prisma/client';
import { buildHydraClientDef, buildTykPolicy, generateClientSecret } from './oauth-client-mapper';

const api = { name: 'Orders', tykApiId: 'gw-123' };

describe('buildHydraClientDef', () => {
  it('issues machine-only credentials scoped to a tenant and an API', () => {
    expect(buildHydraClientDef({ name: 'Partner', tenantId: 't1', apiDefId: 'a1', secret: 's3cret' })).toEqual({
      client_name: 'Partner',
      client_secret: 's3cret',
      grant_types: ['client_credentials'],
      response_types: [],
      redirect_uris: [],
      scope: '',
      token_endpoint_auth_method: 'client_secret_post',
      // The only field Hydra's list endpoint can filter on server-side.
      owner: 't1',
      metadata: { tenantId: 't1', apiDefId: 'a1' },
    });
  });
});

describe('generateClientSecret', () => {
  it('is URL-safe and unguessable', () => {
    const secret = generateClientSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).not.toBe(generateClientSecret());
  });
});

describe('buildTykPolicy', () => {
  it('grants only the one API, with no limits by default', () => {
    expect(buildTykPolicy('Partner', api, {}, 'org1')).toEqual({
      name: 'Orders — Partner',
      org_id: 'org1',
      active: true,
      state: 'active',
      rate: 0,
      per: 0,
      quota_max: -1,
      access_rights: { 'gw-123': { api_id: 'gw-123', api_name: 'Orders', versions: ['Default'] } },
    });
  });

  it('leaves the id to the caller, which fills in the Hydra client id', () => {
    expect(buildTykPolicy('Partner', api, {}, 'org1')).not.toHaveProperty('id');
  });

  it('maps a per-second rate limit', () => {
    expect(buildTykPolicy('P', api, { rateLimitPerSecond: 10 }, 'org1')).toMatchObject({ rate: 10, per: 1 });
  });

  it('maps a quota to its renewal period in seconds', () => {
    expect(buildTykPolicy('P', api, { quotaLimit: 1000, quotaPeriod: QuotaPeriod.DAILY }, 'org1')).toMatchObject({
      quota_max: 1000,
      quota_renewal_rate: 86_400,
    });
  });

  it('refuses a quota with no period', () => {
    expect(() => buildTykPolicy('P', api, { quotaLimit: 1000 }, 'org1')).toThrow(BadRequestException);
  });

  it('refuses an API that is not on the gateway yet', () => {
    expect(() => buildTykPolicy('P', { name: 'Orders', tykApiId: null }, {}, 'org1')).toThrow(BadRequestException);
  });
});
