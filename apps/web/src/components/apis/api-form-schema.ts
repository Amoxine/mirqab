import { z } from 'zod';
import type { ApiConfig } from '@/types';
import type { ApiDefinition, CreateApiInput, UpdateApiInput } from '@/hooks/use-apis';

/** Comma-separated text -> trimmed, non-empty list. */
const csv = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

/** A `useTranslations('apis')` translator — typed loosely (not `ReturnType<typeof useTranslations>`)
 * so this file has no 'use client'-only import; the real function's call signature is compatible. */
type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/** Whole-number text input -> number (kept as text in the form so an empty field stays empty). `t`
 * is `useTranslations('apis')` — messages need it, so this (and `apiFormSchema` below) is a factory,
 * called once via `useMemo`, not a static schema; the shape/validation logic still lives here. */
const wholeNumber = (t: Translate, min: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, t('form.errors.wholeNumberInvalid'))
    .transform(Number)
    .refine((value) => value >= min, t('form.errors.wholeNumberTooSmall', { min }));

/** The auth types the dashboard can configure, in the order the form lists them. */
export const AUTH_TYPES = ['AUTH_TOKEN', 'OAUTH', 'NONE'] as const;

export function makeApiFormSchema(t: Translate) {
  return z.object({
    name: z.string().trim().min(2, t('form.errors.nameTooShort')).max(100, t('form.errors.nameTooLong')),
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, t('form.errors.slugInvalid')),
    // ponytail: JWT (bring-your-own issuer) is in the API enum but has no Tyk JWKS/policy mapping, so
    // it is deliberately not offered here — see `jwtFieldsForOAuth` in the API's api.service.ts.
    authType: z.enum(['NONE', 'AUTH_TOKEN', 'OAUTH']),
    proxyUrl: z
      .string()
      .url(t('form.errors.urlInvalid'))
      .regex(/^https?:\/\//, t('form.errors.urlMustStartWithScheme')),
    listenPath: z
      .string()
      .min(1, t('form.errors.listenPathRequired'))
      .startsWith('/', t('form.errors.listenPathMustStartWithSlash')),
    rateLimitRate: wholeNumber(t, 0),
    rateLimitPer: wholeNumber(t, 1),
    corsEnable: z.boolean(),
    corsAllowedOrigins: csv,
    corsAllowedMethods: csv,
    corsAllowedHeaders: csv,
    corsExposedHeaders: csv,
    corsAllowCredentials: z.boolean(),
    corsMaxAge: wholeNumber(t, 0),
    doNotTrack: z.boolean(),
  });
}

/** What the inputs hold (text for lists and numbers). */
export type ApiFormInput = z.input<ReturnType<typeof makeApiFormSchema>>;
/** What the schema produces (arrays and numbers). */
export type ApiFormValues = z.infer<ReturnType<typeof makeApiFormSchema>>;

/** Form defaults: blank for create, the API's current values for edit. */
export function toFormInput(api?: ApiDefinition): ApiFormInput {
  const config: ApiConfig = api?.config ?? {};
  const { rateLimit, cors } = config;
  return {
    name: api?.name ?? '',
    slug: api?.slug ?? '',
    authType: AUTH_TYPES.find((type) => type === api?.authType) ?? 'AUTH_TOKEN',
    proxyUrl: api?.proxyUrl ?? '',
    listenPath: api?.listenPath ?? '/',
    // rate 0 = no per-API limit (spec §3.2)
    rateLimitRate: String(rateLimit?.rate ?? 0),
    rateLimitPer: String(rateLimit?.per ?? 60),
    corsEnable: cors?.enable ?? false,
    corsAllowedOrigins: (cors?.allowedOrigins ?? []).join(', '),
    corsAllowedMethods: (cors?.allowedMethods ?? []).join(', '),
    corsAllowedHeaders: (cors?.allowedHeaders ?? []).join(', '),
    corsExposedHeaders: (cors?.exposedHeaders ?? []).join(', '),
    corsAllowCredentials: cors?.allowCredentials ?? false,
    corsMaxAge: String(cors?.maxAge ?? 0),
    doNotTrack: config.doNotTrack ?? false,
  };
}

/** Parsed form values -> the `config` JSON the API stores (spec §3.2). Always the full object: the API replaces `config`. */
export function toApiConfig(values: ApiFormValues): ApiConfig {
  return {
    rateLimit: { rate: values.rateLimitRate, per: values.rateLimitPer },
    cors: {
      enable: values.corsEnable,
      allowedOrigins: values.corsAllowedOrigins,
      allowedMethods: values.corsAllowedMethods,
      allowedHeaders: values.corsAllowedHeaders,
      exposedHeaders: values.corsExposedHeaders,
      allowCredentials: values.corsAllowCredentials,
      maxAge: values.corsMaxAge,
    },
    doNotTrack: values.doNotTrack,
  };
}

/** Parsed form values -> the create payload. */
export function toCreatePayload(values: ApiFormValues): CreateApiInput {
  return {
    name: values.name,
    slug: values.slug,
    proxyUrl: values.proxyUrl,
    listenPath: values.listenPath,
    authType: values.authType,
    config: toApiConfig(values),
  };
}

/** Parsed form values -> the update payload (the slug is immutable, so it is left out). */
export function toUpdatePayload(values: ApiFormValues): UpdateApiInput {
  const { slug: _slug, ...rest } = toCreatePayload(values);
  return rest;
}
