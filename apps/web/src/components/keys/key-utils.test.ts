import { describe, expect, it } from 'vitest';
import {
  emptyKeyFormValues,
  formatRate,
  makeCreateKeyFormSchema,
  makeKeyFormSchema,
  periodFromSeconds,
  quotaUsedPercent,
  toCreatePayload,
  toDate,
  toUpdatePayload,
  valuesFromKey,
} from './key-utils';

const base = { ...emptyKeyFormValues, name: ' Prod key ', apiDefId: 'api-1' };
// A stub translator: schema/formatting tests assert on validation OUTCOME (`.success`) and on
// formatting behaviour with an explicit label, never on message text, so any string here works.
const t = (key: string) => key;
const keyFormSchema = makeKeyFormSchema(t);
const createKeyFormSchema = makeCreateKeyFormSchema(t);

describe('toCreatePayload', () => {
  it('omits blank optional fields', () => {
    expect(toCreatePayload(base)).toEqual({ name: 'Prod key', apiDefId: 'api-1' });
  });

  it('sends rate, quota and an ISO end-of-day expiry when set; a 0 rate is omitted', () => {
    const payload = toCreatePayload({
      ...base,
      expiresAt: '2030-01-31',
      rateLimitPerSecond: '10',
      quotaLimit: '1000',
      quotaPeriod: 'HOURLY',
    });
    expect(payload).toEqual({
      name: 'Prod key',
      apiDefId: 'api-1',
      expiresAt: '2030-01-31T23:59:59.999Z',
      rateLimitPerSecond: 10,
      quotaLimit: 1000,
      quotaPeriod: 'HOURLY',
    });
    expect(toCreatePayload({ ...base, rateLimitPerSecond: '0' })).not.toHaveProperty('rateLimitPerSecond');
  });
});

describe('toUpdatePayload', () => {
  it('sends explicit "none" for blank fields (0 rate, 0 quota, null expiry) and no quotaPeriod without a limit', () => {
    expect(toUpdatePayload(base)).toEqual({
      name: 'Prod key',
      rateLimitPerSecond: 0,
      expiresAt: null,
      quotaLimit: 0,
    });
  });

  it('sends the quota with its period and an ISO end-of-day expiry when set', () => {
    expect(
      toUpdatePayload({
        ...base,
        expiresAt: '2030-01-31',
        rateLimitPerSecond: '10',
        quotaLimit: '1000',
        quotaPeriod: 'HOURLY',
      }),
    ).toEqual({
      name: 'Prod key',
      rateLimitPerSecond: 10,
      expiresAt: '2030-01-31T23:59:59.999Z',
      quotaLimit: 1000,
      quotaPeriod: 'HOURLY',
    });
  });
});

describe('valuesFromKey', () => {
  const key = {
    id: 'k1',
    name: 'K',
    status: 'ACTIVE' as const,
    apiDefId: 'api-1',
    apiDefName: 'API',
    planId: null,
    planName: null,
    expiresAt: '2030-01-31T23:59:59.999Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    tyk: { rate: 25, per: 1, quotaMax: 500, quotaRemaining: 10, quotaRenewalRate: 86400, quotaRenewsAt: 0 },
  };

  it('maps live gateway values back into the form', () => {
    expect(valuesFromKey(key)).toEqual({
      name: 'K',
      apiDefId: 'api-1',
      planId: '',
      expiresAt: '2030-01-31',
      rateLimitPerSecond: '25',
      quotaLimit: '500',
      quotaPeriod: 'DAILY',
    });
  });

  it('treats no gateway limits (rate 0, quota -1) as blank', () => {
    const values = valuesFromKey({ ...key, tyk: { ...key.tyk, rate: 0, quotaMax: -1 } });
    expect(values.rateLimitPerSecond).toBe('');
    expect(values.quotaLimit).toBe('');
  });
});

describe('schemas', () => {
  it('requires an API on create but not on edit', () => {
    expect(createKeyFormSchema.safeParse({ ...base, apiDefId: '' }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...base, apiDefId: '' }).success).toBe(true);
  });

  it('rejects negative/fractional rate, zero quota and past expiry', () => {
    expect(keyFormSchema.safeParse({ ...base, rateLimitPerSecond: '-1' }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...base, rateLimitPerSecond: '1.5' }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...base, quotaLimit: '0' }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...base, expiresAt: '2000-01-01' }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...base, rateLimitPerSecond: '0', quotaLimit: '5' }).success).toBe(true);
  });
});

describe('formatting', () => {
  it('formats rate limits', () => {
    expect(formatRate(0, 1, 'Unlimited')).toBe('Unlimited');
    expect(formatRate(10, 1, 'Unlimited')).toBe('10 req/s');
    expect(formatRate(100, 60, 'Unlimited')).toBe('100 req / 60 s');
  });

  it('computes quota consumption, clamped, and null when there is no quota', () => {
    expect(quotaUsedPercent(1000, 250)).toBe(75);
    expect(quotaUsedPercent(100, -5)).toBe(100);
    expect(quotaUsedPercent(null, null)).toBeNull();
    expect(quotaUsedPercent(-1, 0)).toBeNull();
  });

  it('maps renewal seconds to a period and reads epoch-seconds or ISO dates', () => {
    expect(periodFromSeconds(3600)).toBe('HOURLY');
    expect(periodFromSeconds(999)).toBe('MONTHLY');
    expect(toDate(1_900_000_000)?.toISOString()).toBe('2030-03-17T17:46:40.000Z');
    expect(toDate('2030-01-01T00:00:00.000Z')?.getUTCFullYear()).toBe(2030);
    expect(toDate(0)).toBeNull();
    expect(toDate('garbage')).toBeNull();
  });
});
