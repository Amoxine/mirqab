/**
 * The grammar of the traffic search bar: `status:>=500 method:POST body:"insufficient funds"` becomes
 * the typed clauses `POST /analytics/traffic/search` accepts. Pure, so it is tested without a browser.
 *
 * The clause shapes mirror `apps/api/src/modules/analytics/search/traffic-search.types.ts` (the web
 * app mirrors API types rather than importing them; see `types/local.ts`). The API validates every
 * clause again, so this parser is a convenience for the person typing, never a security boundary.
 * A shared table of examples pins both sides together (`traffic-search.test.ts` here,
 * `traffic-search.validate.spec.ts` there).
 *
 * Errors are codes, not sentences: the search bar translates them (`analytics.search.errors`).
 */

/** Mirrors `SEARCH_LIMITS` and the bounds in `traffic-search.validate.ts`; the shared tables in both test files pin the two together. */
export const SEARCH_LIMITS = {
  maxClauses: 8,
  maxBodyClauses: 3,
  minTerm: 3,
  maxValueLength: 200,
  maxStatusValues: 10,
  minStatus: 100,
  maxStatus: 599,
  maxLatencyMs: 3_600_000,
} as const;

/** Words in almost every captured body; a search for one only ever times out. Same set as the API. */
const STOP_WORDS: ReadonlySet<string> = new Set(['id', 'data', 'name', 'value', 'true', 'false', 'null', 'type', 'status', 'message']);

export type CompareOp = '>' | '>=' | '<' | '<=';
export type StatusMatch =
  | { type: 'cmp'; op: CompareOp; value: number }
  | { type: 'range'; from: number; to: number }
  | { type: 'in'; values: number[] };

export type SearchClause = { neg: boolean } & (
  | { kind: 'status'; match: StatusMatch }
  | { kind: 'latency'; op: CompareOp; value: number }
  | { kind: 'method'; values: string[] }
  | { kind: 'path'; value: string }
  /** The whole path, not a prefix of it: one endpoint, however short its path. */
  | { kind: 'route'; value: string }
  | { kind: 'api'; value: string }
  | { kind: 'key'; value: string }
  | { kind: 'header'; side: 'req' | 'res'; name: string; value?: string }
  | { kind: 'body'; side: 'req' | 'res' | 'any'; value: string }
);

export type SearchErrorCode =
  | 'unknownField'
  | 'needsValue'
  | 'tooLong'
  | 'status'
  | 'latency'
  | 'method'
  | 'headerName'
  | 'termTooShort'
  | 'commonWord'
  /** `~` (substring) was measured too slow to offer; only `:` is understood. */
  | 'unsupportedOperator';

export interface SearchError {
  code: SearchErrorCode;
  /** Interpolation values for the translated message. */
  params: Record<string, string | number>;
}

export type ParsedToken = { ok: true; clause: SearchClause } | { ok: false; error: SearchError };

/** Field names the bar understands, in the order the suggestions list them. */
export const SEARCH_FIELDS = [
  'status',
  'method',
  'latency',
  'path',
  'route',
  'api',
  'key',
  'reqh',
  'resh',
  'body',
  'req',
  'res',
] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

const isField = (name: string): name is SearchField => (SEARCH_FIELDS as readonly string[]).includes(name);

/** Splits on whitespace outside double quotes, so `body:"insufficient funds"` stays one token. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (/\s/.test(ch) && !quoted) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * A value as it must be written after `field:` so `tokenize`/`parseToken` read it back unchanged: bare
 * when it has no whitespace, double-quoted when it has. `null` when it cannot be written at all: the
 * tokenizer has no escape for `"` or a line break, and an empty value is a `needsValue` error. Anything that is not a
 * string (a name the API sent as `null`) cannot be written either, rather than throwing while rendering.
 */
export function quoteValue(value: unknown): string | null {
  // A line break cannot be carried either: `parseToken` reads a quoted value with `.`, which does not match one.
  if (typeof value !== 'string' || value === '' || value.includes('"') || /[\r\n\u2028\u2029]/.test(value)) return null;
  return /\s/.test(value) ? `"${value}"` : value;
}

const err = (code: SearchErrorCode, params: SearchError['params'] = {}): ParsedToken => ({
  ok: false,
  error: { code, params },
});

const alnumLength = (value: string): number => (value.match(/[\p{L}\p{N}]/gu) ?? []).length;

const isStatusCode = (n: number): boolean => n >= SEARCH_LIMITS.minStatus && n <= SEARCH_LIMITS.maxStatus;

/** The same bounds the API enforces: a code outside 100-599, an inverted range or more than 10 codes is a 400 there. */
function parseStatus(value: string): StatusMatch | null {
  let m = /^(>=|<=|>|<)(\d{3})$/.exec(value);
  if (m?.[1] && m[2]) return isStatusCode(Number(m[2])) ? { type: 'cmp', op: m[1] as CompareOp, value: Number(m[2]) } : null;
  m = /^([1-5])xx$/i.exec(value);
  if (m?.[1]) return { type: 'range', from: Number(m[1]) * 100, to: Number(m[1]) * 100 + 99 };
  m = /^(\d{3})-(\d{3})$/.exec(value);
  if (m?.[1] && m[2]) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    return isStatusCode(from) && isStatusCode(to) && from <= to ? { type: 'range', from, to } : null;
  }
  if (/^\d{3}(,\d{3})*$/.test(value)) {
    const values = value.split(',').map(Number);
    return values.length <= SEARCH_LIMITS.maxStatusValues && values.every(isStatusCode) ? { type: 'in', values } : null;
  }
  return null;
}

/** One token (`-status:404`, `body~fund`, a bare word) to a clause, or the reason it is not one. */
export function parseToken(raw: string): ParsedToken {
  let text = raw;
  const neg = text.startsWith('-');
  if (neg) text = text.slice(1);

  const m = /^([a-z]+)([:~])(.*)$/.exec(text);
  const field = m?.[1] ?? 'body';
  if (m?.[2] === '~') return err('unsupportedOperator', { field });
  const value = (m ? (m[3] ?? '') : text).replace(/^"(.*)"$/, '$1');

  if (!isField(field)) return err('unknownField', { field });
  if (value === '') return err('needsValue', { field });
  if (value.length > SEARCH_LIMITS.maxValueLength) return err('tooLong', { max: SEARCH_LIMITS.maxValueLength });

  switch (field) {
    case 'status': {
      const match = parseStatus(value);
      return match ? { ok: true, clause: { kind: 'status', neg, match } } : err('status');
    }
    case 'latency': {
      const lm = /^(>=|<=|>|<)?(\d+)$/.exec(value);
      // Up to an hour, as in the API; `Number` of a very long digit string is Infinity, which is over it too.
      return lm?.[2] && Number(lm[2]) <= SEARCH_LIMITS.maxLatencyMs
        ? { ok: true, clause: { kind: 'latency', neg, op: (lm[1] ?? '>=') as CompareOp, value: Number(lm[2]) } }
        : err('latency');
    }
    case 'method': {
      const values = value.toUpperCase().split(',');
      return values.every((v) => /^[A-Z]{3,7}$/.test(v)) && values.length <= 7
        ? { ok: true, clause: { kind: 'method', neg, values } }
        : err('method');
    }
    case 'path': {
      if (alnumLength(value) < SEARCH_LIMITS.minTerm) return err('termTooShort', { min: SEARCH_LIMITS.minTerm });
      return { ok: true, clause: { kind: 'path', neg, value } };
    }
    // The whole path, so it needs no minimum length: it cannot match more than the endpoint it names.
    case 'route':
      return { ok: true, clause: { kind: 'route', neg, value } };
    case 'api':
      return { ok: true, clause: { kind: 'api', neg, value } };
    case 'key':
      return { ok: true, clause: { kind: 'key', neg, value } };
    case 'reqh':
    case 'resh': {
      const eq = value.indexOf('=');
      const name = (eq < 0 ? value : value.slice(0, eq)).toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(name)) return err('headerName');
      const side = field === 'reqh' ? 'req' : 'res';
      const headerValue = eq < 0 ? undefined : value.slice(eq + 1);
      if (headerValue === '') return err('needsValue', { field });
      return {
        ok: true,
        clause: headerValue === undefined ? { kind: 'header', neg, side, name } : { kind: 'header', neg, side, name, value: headerValue },
      };
    }
    case 'body':
    case 'req':
    case 'res': {
      const words = value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      // Mirrors the API: at least one real word of minTerm+ letters or digits that is not a stop word.
      if (!words.some((w) => alnumLength(w) >= SEARCH_LIMITS.minTerm)) return err('termTooShort', { min: SEARCH_LIMITS.minTerm });
      if (words.every((w) => STOP_WORDS.has(w) || alnumLength(w) < SEARCH_LIMITS.minTerm)) return err('commonWord', { term: value });
      const side = field === 'body' ? 'any' : field;
      return { ok: true, clause: { kind: 'body', neg, side, value } };
    }
  }
}
