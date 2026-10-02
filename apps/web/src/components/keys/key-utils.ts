import { z } from 'zod';
import type { CreateKeyPayload, KeyDetail, QuotaPeriod, UpdateKeyPayload } from '@/hooks/use-keys';

// Pure form/formatting logic for the keys UI, kept free of React so it can be unit-tested.

export const QUOTA_PERIODS = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;

/** Same seconds the API sends to the gateway as `quota_renewal_rate`. */
const PERIOD_SECONDS: Record<QuotaPeriod, number> = {
  HOURLY: 3600,
  DAILY: 86400,
  WEEKLY: 604800,
  MONTHLY: 2592000,
};

/** `t` is `useTranslations('keys')` — messages need it, so this is a factory (called once via
 * `useMemo`, not per-render) rather than a static schema. The shape/validation logic still lives
 * here, at module scope; only the message strings are parameterized. */
const wholeNumber = (t: (key: string) => string, errorKey: string, min: number) =>
  z.string().refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= min), t(errorKey));

/** A picked date means "valid through the end of that day" (UTC). */
const endOfDayUtc = (date: string) => new Date(`${date}T23:59:59.999Z`);

export function makeKeyFormSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().trim().min(1, t('form.errors.nameRequired')).max(100, t('form.errors.nameTooLong')),
    apiDefId: z.string(),
    // WP19: a select, and optional — '' means "no plan", which is a fully-functional key, not an error.
    planId: z.string(),
    expiresAt: z
      .string()
      .refine((v) => v === '' || endOfDayUtc(v).getTime() > Date.now(), t('form.errors.expiryMustBeFuture')),
    rateLimitPerSecond: wholeNumber(t, 'form.errors.rateLimitInvalid', 0),
    quotaLimit: wholeNumber(t, 'form.errors.quotaInvalid', 1),
    quotaPeriod: z.enum(QUOTA_PERIODS),
  });
}

/** Create additionally requires an API; edit cannot change it. */
export function makeCreateKeyFormSchema(t: (key: string) => string) {
  return makeKeyFormSchema(t).extend({
    apiDefId: z.string().min(1, t('form.errors.apiRequired')),
  });
}

export type KeyFormValues = z.infer<ReturnType<typeof makeKeyFormSchema>>;

export const emptyKeyFormValues: KeyFormValues = {
  name: '',
  apiDefId: '',
  planId: '',
  expiresAt: '',
  rateLimitPerSecond: '',
  quotaLimit: '',
  quotaPeriod: 'MONTHLY',
};

export function periodFromSeconds(seconds: number | null | undefined): QuotaPeriod {
  return QUOTA_PERIODS.find((p) => PERIOD_SECONDS[p] === seconds) ?? 'MONTHLY';
}

/** Edit-form defaults from the live key. Blank rate/quota = none configured. */
export function valuesFromKey(key: KeyDetail): KeyFormValues {
  const { tyk } = key;
  return {
    name: key.name,
    apiDefId: key.apiDefId ?? '',
    planId: key.planId ?? '',
    expiresAt: key.expiresAt ? key.expiresAt.slice(0, 10) : '',
    rateLimitPerSecond:
      tyk && tyk.rate > 0 ? String(Math.max(1, Math.round(tyk.rate / Math.max(tyk.per, 1)))) : '',
    quotaLimit: tyk && tyk.quotaMax > 0 ? String(tyk.quotaMax) : '',
    quotaPeriod: periodFromSeconds(tyk?.quotaRenewalRate),
  };
}

/** Optional fields are omitted (not sent as empty) — the API validates them when present. */
export function toCreatePayload(v: KeyFormValues): CreateKeyPayload {
  const rate = v.rateLimitPerSecond === '' ? 0 : Number(v.rateLimitPerSecond);
  return {
    name: v.name.trim(),
    apiDefId: v.apiDefId,
    ...(v.planId ? { planId: v.planId } : {}),
    ...(v.expiresAt ? { expiresAt: endOfDayUtc(v.expiresAt).toISOString() } : {}),
    ...(rate > 0 ? { rateLimitPerSecond: rate } : {}),
    ...(v.quotaLimit ? { quotaLimit: Number(v.quotaLimit), quotaPeriod: v.quotaPeriod } : {}),
  };
}

/** Edit: blank means "none" and is sent explicitly, so a rate limit (`0`), quota (`0`) or expiry (`null`) can be removed. */
export function toUpdatePayload(v: KeyFormValues): UpdateKeyPayload {
  return {
    name: v.name.trim(),
    rateLimitPerSecond: v.rateLimitPerSecond === '' ? 0 : Number(v.rateLimitPerSecond),
    expiresAt: v.expiresAt ? endOfDayUtc(v.expiresAt).toISOString() : null,
    ...(v.quotaLimit
      ? { quotaLimit: Number(v.quotaLimit), quotaPeriod: v.quotaPeriod }
      : { quotaLimit: 0 }),
  };
}

export interface RateLabels {
  perSecond: (rate: number) => string;
  every: (rate: number, seconds: number) => string;
}

/** The rate wording in the UI language. `t` is `useTranslations('common')`; the units live in its
 * `rate.*` messages, so no locale's "req/s" is written in code. */
export const rateLabels = (t: (key: 'rate.perSecond' | 'rate.every', values: Record<string, number>) => string): RateLabels => ({
  perSecond: (rate) => t('rate.perSecond', { rate }),
  every: (rate, seconds) => t('rate.every', { rate, seconds }),
});

/** `unlimitedLabel` is the caller's already-translated `t('form.rateLimitPlaceholder')` — same word,
 * one key, rather than a second "unlimited" string to keep in sync across locales. `labels` is
 * `rateLabels(t)` and is only asked when there is a rate to spell out. */
export function formatRate(rate: number, per: number, unlimitedLabel: string, labels: RateLabels): string {
  if (rate <= 0) return unlimitedLabel;
  return per === 1 ? labels.perSecond(rate) : labels.every(rate, per);
}

/** `everyNSeconds` is the caller's `(seconds) => t('form.everyNSeconds', { seconds })`: a callback, not a
 * template string, because the message cannot be formatted without its value, and it is only needed
 * off the four standard periods. */
export function formatQuotaPeriod(
  seconds: number,
  periodLabels: Record<QuotaPeriod, string>,
  everyNSeconds: (seconds: number) => string,
): string {
  const period = QUOTA_PERIODS.find((p) => PERIOD_SECONDS[p] === seconds);
  return period ? periodLabels[period] : everyNSeconds(seconds);
}

/** Percentage of quota consumed (0-100), or `null` when there is no quota to measure against. */
export function quotaUsedPercent(max: number | null, remaining: number | null): number | null {
  if (max === null || remaining === null || max <= 0) return null;
  return Math.min(100, Math.max(0, ((max - remaining) / max) * 100));
}

/** The gateway reports epoch seconds; ISO strings are accepted too. Returns `null` for anything unusable. */
export function toDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === 0 || value === '') return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
