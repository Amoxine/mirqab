import { z } from 'zod';

/**
 * Text <-> list codecs shared by every Designer Sheet that edits an array field. Every middleware
 * config array (IP lists, header add/remove, LB targets, uptime tests...) is edited as one line of
 * text per entry rather than a dynamic add/remove row UI — smaller, and it matches the convention
 * `api-form-schema.ts` already set for CORS's comma-separated lists.
 */

/** One entry per non-blank line, trimmed. Blank textarea -> []. */
export const linesToArray = z.string().transform((text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);

/** Comma-separated text -> string[] (mirrors `api-form-schema.ts`'s `csv`). */
export const csvToArray = z.string().transform((text) =>
  text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

/** string[] -> one entry per line (the inverse of `linesToArray`, for populating a Textarea default). */
export const arrayToLines = (items?: string[] | null): string => (items ?? []).join('\n');

/** "name: value" per line -> `{name, value}[]`. A line with no `:` fails validation instead of being dropped silently. */
export function pairLines(invalidMessage: string) {
  return z.string().transform((text, ctx) => {
    const out: { name: string; value: string }[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
        return z.NEVER;
      }
      out.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
    }
    return out;
  });
}

/** `{name, value}[]` -> "name: value" per line (the inverse of `pairLines`). */
export const pairsToLines = (items?: { name: string; value: string }[] | null): string =>
  (items ?? []).map((item) => `${item.name}: ${item.value}`).join('\n');

/** Whole-number text -> number, `min` inclusive (and `max` inclusive when given). Mirrors
 * `api-form-schema.ts`'s `wholeNumber`. */
export function wholeNumber(invalidMessage: string, rangeMessage: string, min: number, max?: number) {
  return z
    .string()
    .trim()
    .regex(/^\d+$/, invalidMessage)
    .transform(Number)
    .refine((value) => value >= min && (max === undefined || value <= max), rangeMessage);
}

/** Whole-number text, blank -> `null` (clears a nullable field) instead of being rejected. */
export function optionalWholeNumber(invalidMessage: string, rangeMessage: string, min: number, max?: number) {
  return z.string().transform((text, ctx) => {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    if (!/^\d+$/.test(trimmed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
      return z.NEVER;
    }
    const value = Number(trimmed);
    if (value < min || (max !== undefined && value > max)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: rangeMessage });
      return z.NEVER;
    }
    return value;
  });
}

/** Decimal text in `[0, 1]` (an error-rate threshold). */
export function fraction01(invalidMessage: string) {
  return z
    .string()
    .trim()
    .refine((v) => /^(0(\.\d+)?|1(\.0+)?)$/.test(v), invalidMessage)
    .transform(Number);
}

/** Comma-separated whole numbers -> number[] (e.g. cacheable response codes). */
export function csvNumbers(invalidMessage: string) {
  return z.string().transform((text, ctx) => {
    const parts = text
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isInteger(n))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
      return z.NEVER;
    }
    return nums;
  });
}
