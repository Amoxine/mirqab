import {
  SEARCH_LIMITS,
  SEARCH_RANGES,
  SEARCH_STOP_WORDS,
  type CompareOp,
  type SearchClause,
  type SearchCursor,
  type SearchRange,
  type StatusMatch,
  type TrafficSearchRequest,
} from './traffic-search.types';

/** Why a search request was refused; the first problem found, in words a person can act on. */
export class SearchValidationError extends Error {}

const COMPARE_OPS: readonly string[] = ['>', '>=', '<', '<='];
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const METHOD = /^[A-Z]{3,7}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CURSOR_ID = /^\d{1,19}$/;

function fail(message: string): never {
  throw new SearchValidationError(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Record<string, unknown>, key: string, label = key): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') return fail(`${label} needs a value.`);
  if (v.length > SEARCH_LIMITS.maxValueLength) {
    return fail(`${label} is longer than ${String(SEARCH_LIMITS.maxValueLength)} characters.`);
  }
  return v;
}

function int(o: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return fail(`${key} must be a whole number from ${String(min)} to ${String(max)}.`);
  }
  return v;
}

function op(o: Record<string, unknown>): CompareOp {
  const v = o.op;
  if (typeof v !== 'string' || !COMPARE_OPS.includes(v)) return fail('op must be >, >=, < or <=.');
  return v as CompareOp;
}

function alnumLength(value: string): number {
  return (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function statusMatch(raw: unknown): StatusMatch {
  if (!isRecord(raw)) return fail('status needs a match.');
  if (raw.type === 'cmp') return { type: 'cmp', op: op(raw), value: int(raw, 'value', 100, 599) };
  if (raw.type === 'range') {
    const from = int(raw, 'from', 100, 599);
    const to = int(raw, 'to', 100, 599);
    if (from > to) return fail('status range starts after it ends.');
    return { type: 'range', from, to };
  }
  if (raw.type === 'in') {
    const values = raw.values;
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > SEARCH_LIMITS.maxStatusValues ||
      !values.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599)
    ) {
      return fail('status list must hold 1 to 10 codes between 100 and 599.');
    }
    return { type: 'in', values: values as number[] };
  }
  return fail('status match must be cmp, range or in.');
}

function clause(raw: unknown): SearchClause {
  if (!isRecord(raw)) return fail('Each filter must be an object.');
  const neg = raw.neg === undefined ? false : raw.neg;
  if (typeof neg !== 'boolean') return fail('neg must be true or false.');

  switch (raw.kind) {
    case 'status':
      return { kind: 'status', neg, match: statusMatch(raw.match) };
    case 'latency':
      return { kind: 'latency', neg, op: op(raw), value: int(raw, 'value', 0, 3_600_000) };
    case 'method': {
      const values = raw.values;
      if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > SEARCH_LIMITS.maxMethods ||
        !values.every((v) => typeof v === 'string' && METHOD.test(v))
      ) {
        return fail('method needs 1 to 7 upper-case method names such as GET or POST.');
      }
      return { kind: 'method', neg, values: values as string[] };
    }
    case 'path': {
      const value = str(raw, 'value', 'path');
      if (alnumLength(value) < SEARCH_LIMITS.minTerm) {
        return fail(`path needs at least ${String(SEARCH_LIMITS.minTerm)} letters or digits.`);
      }
      return { kind: 'path', neg, value };
    }
    case 'api':
      return { kind: 'api', neg, value: str(raw, 'value', 'api') };
    case 'key':
      return { kind: 'key', neg, value: str(raw, 'value', 'key') };
    case 'header': {
      const side = raw.side;
      if (side !== 'req' && side !== 'res') return fail('header side must be req or res.');
      const name = str(raw, 'name', 'header name');
      if (!HEADER_NAME.test(name)) return fail('Header names use lower-case letters, digits and dashes.');
      const value = raw.value === undefined ? undefined : str(raw, 'value', 'header value');
      return value === undefined ? { kind: 'header', neg, side, name } : { kind: 'header', neg, side, name, value };
    }
    case 'body': {
      const side = raw.side;
      if (side !== 'req' && side !== 'res' && side !== 'any') return fail('body side must be req, res or any.');
      const value = str(raw, 'value', 'body');
      const words = value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (alnumLength(value) < SEARCH_LIMITS.minTerm) {
        return fail(`Use at least ${String(SEARCH_LIMITS.minTerm)} letters or digits: a shorter term matches too much.`);
      }
      if (words.every((w) => SEARCH_STOP_WORDS.has(w))) {
        return fail(`"${value}" appears in almost every request; search for something more specific.`);
      }
      return { kind: 'body', neg, side, value };
    }
    default:
      return fail('Unknown filter kind.');
  }
}

function cursor(raw: unknown): SearchCursor | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || typeof raw.ts !== 'string' || typeof raw.id !== 'string') return fail('cursor is malformed.');
  if (!ISO_TS.test(raw.ts) || !CURSOR_ID.test(raw.id)) return fail('cursor is malformed.');
  return { ts: raw.ts, id: raw.id };
}

/** Validates an untrusted request body. Throws `SearchValidationError` on the first problem. */
export function validateSearchRequest(input: unknown): TrafficSearchRequest {
  if (!isRecord(input)) return fail('The request body must be an object.');
  const range = input.range === undefined ? '24h' : input.range;
  if (typeof range !== 'string' || !(SEARCH_RANGES as readonly string[]).includes(range)) {
    return fail('range must be 1h, 24h, 7d or 30d.');
  }
  const rawClauses = input.clauses === undefined ? [] : input.clauses;
  if (!Array.isArray(rawClauses)) return fail('clauses must be a list.');
  if (rawClauses.length > SEARCH_LIMITS.maxClauses) {
    return fail(`At most ${String(SEARCH_LIMITS.maxClauses)} filters per search.`);
  }
  const limit = input.limit === undefined ? SEARCH_LIMITS.defaultPageSize : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.maxPageSize) {
    return fail(`limit must be a whole number from 1 to ${String(SEARCH_LIMITS.maxPageSize)}.`);
  }
  const parsedCursor = cursor(input.cursor);
  const clauses = rawClauses.map(clause);
  if (clauses.filter((c) => c.kind === 'body').length > SEARCH_LIMITS.maxBodyClauses) {
    return fail(`At most ${String(SEARCH_LIMITS.maxBodyClauses)} body-text filters per search.`);
  }
  return {
    range: range as SearchRange,
    clauses,
    limit,
    ...(parsedCursor ? { cursor: parsedCursor } : {}),
  };
}
