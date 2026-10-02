import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import arCommon from '@/messages/ar/common.json';
import arKeys from '@/messages/ar/keys.json';
import enCommon from '@/messages/en/common.json';
import enKeys from '@/messages/en/keys.json';
import frCommon from '@/messages/fr/common.json';
import frKeys from '@/messages/fr/keys.json';
import type { QuotaPeriod } from '@/hooks/use-keys';
import {
  QUOTA_PERIODS,
  emptyKeyFormValues,
  formatQuotaPeriod,
  formatRate,
  rateLabels,
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

describe('formatRate', () => {
  const COMMON = { en: enCommon, fr: frCommon, ar: arCommon };
  // The three files share one shape; typing them as the English one gives the translator exact keys.
  const labelsFor = (locale: keyof typeof COMMON) =>
    rateLabels(createTranslator({ locale, messages: { common: COMMON[locale] as typeof enCommon }, namespace: 'common' }));

  it.each([
    ['en', '10 req/s', '100 req / 60 s'],
    ['fr', '10 req/s', '100 req / 60 s'],
    ['ar', '10 طلب/ث', '100 طلب / 60 ث'],
  ] as const)('spells a rate out in %s: per second, and per N seconds', (locale, perSecond, perMinute) => {
    const labels = labelsFor(locale);
    expect(formatRate(10, 1, 'Unlimited', labels)).toBe(perSecond);
    expect(formatRate(100, 60, 'Unlimited', labels)).toBe(perMinute);
  });

  it('says "unlimited" with the caller\'s word when there is no rate limit, formatting nothing', () => {
    const mustNotBeAsked = { perSecond: () => 'no', every: () => 'no' };
    expect(formatRate(0, 1, 'Unlimited', mustNotBeAsked)).toBe('Unlimited');
    expect(formatRate(-1, 60, 'Illimité', mustNotBeAsked)).toBe('Illimité');
  });
});

describe('formatting', () => {
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

describe('formatQuotaPeriod', () => {
  const KEYS = { en: enKeys, fr: frKeys, ar: arKeys };
  const forLocale = (locale: keyof typeof KEYS) => {
    const translate = createTranslator({ locale, messages: { keys: KEYS[locale] }, namespace: 'keys' });
    const labels = Object.fromEntries(QUOTA_PERIODS.map((p) => [p, translate(`form.quotaPeriods.${p}`)])) as Record<
      QuotaPeriod,
      string
    >;
    return { labels, every: (seconds: number) => translate('form.everyNSeconds', { seconds }) };
  };

  it.each(['en', 'fr', 'ar'] as const)('names the four standard periods without formatting "every N" in %s', (locale) => {
    const { labels } = forLocale(locale);
    const mustNotBeAsked = () => {
      throw new Error('"every N seconds" was formatted for a standard period');
    };
    expect(formatQuotaPeriod(3600, labels, mustNotBeAsked)).toBe(labels.HOURLY);
    expect(formatQuotaPeriod(86400, labels, mustNotBeAsked)).toBe(labels.DAILY);
    expect(formatQuotaPeriod(604800, labels, mustNotBeAsked)).toBe(labels.WEEKLY);
    expect(formatQuotaPeriod(2592000, labels, mustNotBeAsked)).toBe(labels.MONTHLY);
  });

  it.each([
    ['en', 7200, 'Every 7200 s'],
    ['en', 90, 'Every 90 s'],
    ['fr', 7200, 'Toutes les 7200 s'],
    ['fr', 90, 'Toutes les 90 s'],
    ['ar', 7200, 'كل 7200 ثانية'],
    ['ar', 90, 'كل 90 ثانية'],
  ] as const)('spells a non-standard period out in %s: %i s -> %s', (locale, seconds, expected) => {
    const { labels, every } = forLocale(locale);
    expect(formatQuotaPeriod(seconds, labels, every)).toBe(expected);
  });
});
