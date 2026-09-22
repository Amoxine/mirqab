import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { QuotaPeriod } from '@prisma/client';
import type { TykKeyState } from '../../tyk-integration/services/tyk-client.service';
import { applyKeyUpdate, buildTykKeyDef, quotaPeriodToSeconds } from './tyk-key-mapper';

const NOW = 1_800_000_000;
const ORG = 'org123';
const API = { name: 'Orders API', tykApiId: 'tyk-api-1' };
const RIGHTS = { 'tyk-api-1': { api_id: 'tyk-api-1', api_name: 'Orders API', versions: ['Default'] } };

describe('quotaPeriodToSeconds', () => {
  it.each([
    [QuotaPeriod.HOURLY, 3600],
    [QuotaPeriod.DAILY, 86_400],
    [QuotaPeriod.WEEKLY, 604_800],
    [QuotaPeriod.MONTHLY, 2_592_000],
  ])('%s -> %i seconds', (period, seconds) => {
    expect(quotaPeriodToSeconds(period)).toBe(seconds);
  });
});

describe('buildTykKeyDef (create)', () => {
  it('maps rate, quota, expiry, alias and access_rights', () => {
    const def = buildTykKeyDef(
      {
        name: 'wp3 key',
        rateLimitPerSecond: 10,
        quotaLimit: 1000,
        quotaPeriod: QuotaPeriod.HOURLY,
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      API,
      ORG,
      NOW,
    );

    expect(def).toEqual({
      alias: 'wp3 key',
      active: true,
      org_id: ORG,
      access_rights: RIGHTS,
      rate: 10,
      per: 1,
      quota_max: 1000,
      quota_renewal_rate: 3600,
      quota_renews: NOW + 3600,
      expires: Date.parse('2027-01-01T00:00:00.000Z') / 1000,
    });
  });

  it('omits rate and per when the rate limit is 0 (unlimited) or absent', () => {
    expect(buildTykKeyDef({ name: 'k', rateLimitPerSecond: 0 }, API, ORG, NOW)).not.toHaveProperty('rate');
    expect(buildTykKeyDef({ name: 'k', rateLimitPerSecond: 0 }, API, ORG, NOW)).not.toHaveProperty('per');
    expect(buildTykKeyDef({ name: 'k' }, API, ORG, NOW)).not.toHaveProperty('rate');
  });

  it('emits no limit fields at all when none are configured', () => {
    expect(buildTykKeyDef({ name: 'k' }, API, ORG, NOW)).toEqual({
      alias: 'k',
      active: true,
      org_id: ORG,
      access_rights: RIGHTS,
    });
  });

  it('omits access_rights when the key is not scoped to a synced API', () => {
    expect(buildTykKeyDef({ name: 'k' }, null, ORG, NOW)).not.toHaveProperty('access_rights');
    expect(buildTykKeyDef({ name: 'k' }, { name: 'x', tykApiId: null }, ORG, NOW)).not.toHaveProperty('access_rights');
  });

  it('treats quotaLimit 0 as no quota, and a quotaPeriod alone as nothing', () => {
    expect(buildTykKeyDef({ name: 'k', quotaLimit: 0, quotaPeriod: QuotaPeriod.DAILY }, API, ORG, NOW)).not.toHaveProperty(
      'quota_max',
    );
    expect(buildTykKeyDef({ name: 'k', quotaPeriod: QuotaPeriod.DAILY }, API, ORG, NOW)).not.toHaveProperty('quota_max');
  });

  it('rejects a quotaLimit without a quotaPeriod', () => {
    expect(() => buildTykKeyDef({ name: 'k', quotaLimit: 5 }, API, ORG, NOW)).toThrow(BadRequestException);
  });
});

describe('applyKeyUpdate (edit)', () => {
  /** Live Tyk state of a key someone configured as 100 requests / 60 s, 500 per hour. */
  const current: TykKeyState = {
    alias: 'old name',
    rate: 100,
    per: 60,
    quota_max: 500,
    quota_remaining: 120,
    quota_renewal_rate: 3600,
    quota_renews: NOW + 1000,
    expires: 1_900_000_000,
    access_rights: RIGHTS,
    meta_data: { owner: 'ops' },
  };

  it('resends everything unchanged for an empty patch (Tyk PUT replaces the whole key)', () => {
    expect(applyKeyUpdate(current, {}, API, ORG, NOW)).toEqual({ ...current, org_id: ORG });
  });

  it('re-adds org_id, which getKey strips from the live state, so a PUT does not reset the key to no org', () => {
    expect(current).not.toHaveProperty('org_id');
    expect(applyKeyUpdate(current, { name: 'renamed' }, API, ORG, NOW)).toMatchObject({ org_id: ORG });
  });

  it('does not mutate the state it was given', () => {
    const snapshot = structuredClone(current);
    applyKeyUpdate(current, { rateLimitPerSecond: 0, quotaLimit: 0, expiresAt: null }, API, ORG, NOW);
    expect(current).toEqual(snapshot);
  });

  it('a name-only patch keeps a non-standard rate window and the running quota window', () => {
    const def = applyKeyUpdate(current, { name: 'new name' }, API, ORG, NOW);
    expect(def).toMatchObject({ alias: 'new name', rate: 100, per: 60, quota_max: 500, quota_renews: NOW + 1000 });
  });

  it('sets a new rate as per-second, and removes it for 0', () => {
    expect(applyKeyUpdate(current, { rateLimitPerSecond: 25 }, API, ORG, NOW)).toMatchObject({ rate: 25, per: 1 });

    const unlimited = applyKeyUpdate(current, { rateLimitPerSecond: 0 }, API, ORG, NOW);
    expect(unlimited).not.toHaveProperty('rate');
    expect(unlimited).not.toHaveProperty('per');
  });

  it('a changed quota restarts its renewal window', () => {
    const def = applyKeyUpdate(current, { quotaLimit: 200, quotaPeriod: QuotaPeriod.DAILY }, API, ORG, NOW);
    expect(def).toMatchObject({ quota_max: 200, quota_renewal_rate: 86_400, quota_renews: NOW + 86_400 });
  });

  it('an identical quota keeps the running window', () => {
    const def = applyKeyUpdate(current, { quotaLimit: 500, quotaPeriod: QuotaPeriod.HOURLY }, API, ORG, NOW);
    expect(def).toMatchObject({ quota_max: 500, quota_renewal_rate: 3600, quota_renews: NOW + 1000 });
  });

  it('a limit-only patch reuses the current period; a period-only patch reuses the current limit', () => {
    expect(applyKeyUpdate(current, { quotaLimit: 900 }, API, ORG, NOW)).toMatchObject({
      quota_max: 900,
      quota_renewal_rate: 3600,
    });
    expect(applyKeyUpdate(current, { quotaPeriod: QuotaPeriod.WEEKLY }, API, ORG, NOW)).toMatchObject({
      quota_max: 500,
      quota_renewal_rate: 604_800,
    });
  });

  it('quotaLimit 0 removes the quota', () => {
    const def = applyKeyUpdate(current, { quotaLimit: 0 }, API, ORG, NOW);
    expect(def).not.toHaveProperty('quota_max');
    expect(def).not.toHaveProperty('quota_renewal_rate');
    expect(def).not.toHaveProperty('quota_renews');
  });

  it('cannot set a quota on a key that has no period to reuse', () => {
    const noQuota: TykKeyState = { alias: 'k', access_rights: RIGHTS };
    expect(() => applyKeyUpdate(noQuota, { quotaLimit: 10 }, API, ORG, NOW)).toThrow(BadRequestException);
  });

  it('sets, and clears with null, the expiry', () => {
    expect(applyKeyUpdate(current, { expiresAt: '2028-01-01T00:00:00.000Z' }, API, ORG, NOW)).toMatchObject({
      expires: Date.parse('2028-01-01T00:00:00.000Z') / 1000,
    });
    expect(applyKeyUpdate(current, { expiresAt: null }, API, ORG, NOW)).not.toHaveProperty('expires');
  });

  it('always resends access_rights: kept from Tyk, rebuilt from the API when Tyk has none', () => {
    const custom = { 'tyk-api-1': { api_id: 'tyk-api-1', api_name: 'Orders API', versions: ['v2'] } };
    expect(applyKeyUpdate({ ...current, access_rights: custom }, { name: 'x' }, API, ORG, NOW)).toMatchObject({
      access_rights: custom,
    });
    expect(applyKeyUpdate({ ...current, access_rights: {} }, { name: 'x' }, API, ORG, NOW)).toMatchObject({
      access_rights: RIGHTS,
    });
  });
});
