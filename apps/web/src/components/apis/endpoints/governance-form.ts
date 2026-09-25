import { z } from 'zod';
import type { EndpointGovernance, EndpointGovernanceInput, GovernanceControl } from '@/lib/api/openapi';

/** Bounds of contract §2, checked again (and authoritatively) by the API. */
export const LIMITS = {
  rate: [1, 1_000_000_000],
  per: [1, 86_400],
  cacheTimeout: [1, 86_400],
  timeoutSeconds: [1, 600],
  // EDGE_BODY_LIMIT_BYTES in apps/api api-config.dto.ts.
  sizeBytes: [1, 10_485_760],
  mockCode: [100, 599],
} as const;
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** The API's own caps (update-endpoints.dto.ts): mock body length and number of cacheable codes. */
export const MAX_MOCK_BODY_CHARS = 64_000;
export const MAX_CACHE_CODES = 20;

type Translate = (key: string, values?: Record<string, string | number>) => string;

const WHOLE = /^\d+$/;

/** A `$ref` anywhere makes the gateway reject the push (contract G8), so it is refused here. */
function hasRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRef);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, child]) => key === '$ref' || hasRef(child));
  }
  return false;
}

/** Parsed JSON Schema object, or the i18n key of why it is not acceptable. */
export function parseSchema(text: string): { schema: Record<string, unknown> } | { error: string } {
  if (new TextEncoder().encode(text).length > MAX_SCHEMA_BYTES) return { error: 'schemaTooLarge' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'schemaInvalidJson' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'schemaNotObject' };
  if (hasRef(parsed)) return { error: 'schemaHasRef' };
  return { schema: parsed as Record<string, unknown> };
}

export function makeGovernanceSchema(t: Translate) {
  return z
    .object({
      enabled: z.boolean(),
      isPublic: z.boolean(),
      rateLimitOn: z.boolean(),
      rate: z.string(),
      per: z.string(),
      timeoutOn: z.boolean(),
      timeoutSeconds: z.string(),
      sizeOn: z.boolean(),
      sizeBytes: z.string(),
      cacheOn: z.boolean(),
      cacheTimeout: z.string(),
      cacheCodes: z.string(),
      mockOn: z.boolean(),
      mockCode: z.string(),
      mockBody: z.string(),
      mockHeaders: z.string(),
      validateOn: z.boolean(),
      schema: z.string(),
    })
    .superRefine((v, ctx) => {
      const whole = (on: boolean, field: keyof typeof v & keyof typeof LIMITS, text: string) => {
        if (!on) return;
        const [min, max] = LIMITS[field];
        const n = Number(text.trim());
        if (!WHOLE.test(text.trim()) || n < min || n > max) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: t('errors.range', { min, max }) });
        }
      };
      whole(v.rateLimitOn, 'rate', v.rate);
      whole(v.rateLimitOn, 'per', v.per);
      whole(v.timeoutOn, 'timeoutSeconds', v.timeoutSeconds);
      whole(v.sizeOn, 'sizeBytes', v.sizeBytes);
      whole(v.cacheOn, 'cacheTimeout', v.cacheTimeout);
      whole(v.mockOn, 'mockCode', v.mockCode);
      const codes = v.cacheCodes.split(',').map((c) => c.trim()).filter(Boolean);
      if (v.cacheOn && codes.some((c) => !/^[1-5]\d\d$/.test(c))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cacheCodes'], message: t('errors.statusCodes') });
      } else if (v.cacheOn && codes.length > MAX_CACHE_CODES) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cacheCodes'], message: t('errors.tooManyCodes', { max: MAX_CACHE_CODES }) });
      }
      if (v.mockOn && v.mockBody.length > MAX_MOCK_BODY_CHARS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mockBody'], message: t('errors.bodyTooLong', { max: MAX_MOCK_BODY_CHARS }) });
      }
      if (v.mockOn && v.mockHeaders.split('\n').some((l) => l.trim() !== '' && l.indexOf(':') < 1)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mockHeaders'], message: t('errors.headerLine') });
      }
      if (v.validateOn) {
        const parsed = parseSchema(v.schema);
        if ('error' in parsed) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schema'], message: t(`errors.${parsed.error}`) });
      }
    });
}

export type GovernanceFormValues = z.infer<ReturnType<typeof makeGovernanceSchema>>;

export function toFormValues(g: EndpointGovernance | null): GovernanceFormValues {
  return {
    enabled: g?.enabled !== false,
    isPublic: g?.auth === 'public',
    rateLimitOn: !!g?.rateLimit,
    rate: String(g?.rateLimit?.rate ?? 100),
    per: String(g?.rateLimit?.per ?? 60),
    timeoutOn: g?.timeoutSeconds !== undefined,
    timeoutSeconds: String(g?.timeoutSeconds ?? 30),
    sizeOn: g?.requestSizeLimitBytes !== undefined,
    sizeBytes: String(g?.requestSizeLimitBytes ?? 1_048_576),
    cacheOn: !!g?.cache,
    cacheTimeout: String(g?.cache?.timeoutSeconds ?? 60),
    cacheCodes: (g?.cache?.cacheResponseCodes ?? [200]).join(', '),
    mockOn: !!g?.mock,
    mockCode: String(g?.mock?.code ?? 200),
    mockBody: g?.mock?.body ?? '',
    mockHeaders: (g?.mock?.headers ?? []).map((h) => `${h.name}: ${h.value}`).join('\n'),
    validateOn: !!g?.validateRequestSchema,
    schema: g?.validateRequestSchema ? JSON.stringify(g.validateRequestSchema, null, 2) : '',
  };
}

/**
 * Form -> the `set`/`clear` of one PATCH. A control that is on is `set` (the API merges it control by
 * control); one that is off is `clear`ed only when it is stored today, so an untouched control is
 * never sent. `offered` limits `set` to controls this endpoint may carry; a stored control can always
 * be cleared, even one the gateway no longer proves (removing it only narrows). Empty = nothing to save.
 */
export function toPatch(
  v: GovernanceFormValues,
  current: EndpointGovernance | null,
  offered: (control: GovernanceControl) => boolean,
): { set: EndpointGovernanceInput; clear: GovernanceControl[] } {
  const set: EndpointGovernanceInput = {};
  const clear: GovernanceControl[] = [];
  const toggle = <K extends GovernanceControl>(control: K, on: boolean, value: () => EndpointGovernanceInput[K]) => {
    if (on) {
      if (!offered(control)) return;
      const next = value();
      // ponytail: key-order-sensitive compare; a false "changed" only re-sends the same value.
      if (JSON.stringify(next) !== JSON.stringify(current?.[control])) set[control] = next;
    } else if (current?.[control] !== undefined) clear.push(control);
  };
  toggle('enabled', !v.enabled, () => false);
  toggle('auth', v.isPublic, () => 'public');
  toggle('rateLimit', v.rateLimitOn, () => ({ rate: Number(v.rate), per: Number(v.per) }));
  toggle('timeoutSeconds', v.timeoutOn, () => Number(v.timeoutSeconds));
  toggle('requestSizeLimitBytes', v.sizeOn, () => Number(v.sizeBytes));
  toggle('cache', v.cacheOn, () => {
    const codes = v.cacheCodes.split(',').map((c) => c.trim()).filter(Boolean).map(Number);
    return { timeoutSeconds: Number(v.cacheTimeout), ...(codes.length ? { cacheResponseCodes: codes } : {}) };
  });
  toggle('mock', v.mockOn, () => {
    const headers = v.mockHeaders
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ name: l.slice(0, l.indexOf(':')).trim(), value: l.slice(l.indexOf(':') + 1).trim() }));
    return { code: Number(v.mockCode), body: v.mockBody, ...(headers.length ? { headers } : {}) };
  });
  toggle('validateRequestSchema', v.validateOn, () => {
    const parsed = parseSchema(v.schema);
    return 'schema' in parsed ? parsed.schema : {};
  });
  return { set, clear };
}
