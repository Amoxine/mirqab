import type { ChipInputSuggestion } from '@open-gateway/ui';
import { SEARCH_FIELDS, parseToken, quoteValue, type SearchField } from './traffic-search';

/**
 * What the search bar offers while a filter is being typed. Pure: the page supplies the translated texts
 * and whatever lists it has loaded, and gets rows back for the combobox in `ChipInput`. Nothing here
 * suggests a token `parseToken` would reject, so a suggestion never turns into an error chip.
 *
 * The current token is the last whitespace-separated word of the draft (whitespace inside double quotes
 * does not count, as in `tokenize`). Before its `:` it is a field name; after, a value for that field.
 */

const isField = (name: string): name is SearchField => (SEARCH_FIELDS as readonly string[]).includes(name);

/** The strings among `values`: what an API row actually carries is only promised by its type. */
const strings = (...values: unknown[]): string[] => values.filter((value): value is string => typeof value === 'string');

/** Classes and thresholds first, then the codes people actually look for. */
export const STATUS_VALUES = [
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  '>=400',
  '>=500',
  '200',
  '201',
  '204',
  '301',
  '302',
  '304',
  '400',
  '401',
  '403',
  '404',
  '409',
  '422',
  '429',
  '500',
  '502',
  '503',
  '504',
] as const;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const LATENCIES_MS = [200, 500, 1000, 2000] as const;
/** Header names worth searching on. Never one that is redacted before storage (authorization, cookies, API keys). */
const HEADERS = [
  'content-type',
  'accept',
  'accept-language',
  'user-agent',
  'x-request-id',
  'x-forwarded-for',
  'origin',
  'referer',
  'cache-control',
  'content-length',
  'content-encoding',
  'retry-after',
  'location',
  'etag',
  'x-ratelimit-remaining',
] as const;

/** A list pulled from the server can be long; the dropdown shows the best matches, not all of them. */
export const MAX_DYNAMIC_SUGGESTIONS = 20;

export interface SuggestContext {
  /** One line on what a field filters on, translated. */
  fieldDescription: (field: SearchField) => string;
  /** What a status value (one of `STATUS_VALUES`) means, translated. */
  statusMeaning: (value: string) => string;
  latencyOver: (ms: number) => string;
  /** The lists below are `undefined` until loaded, and stay so if loading fails: that field then has no rows. */
  apis?: { slug: string; name: string }[];
  /** Key names: what `key:` matches exactly. */
  keys?: { name: string; apiName: string | null }[];
  paths?: string[];
}

/** One word the person could pick: `label` is what is written (and shown), `matchOn` what typing is compared with. */
interface Option {
  label: string;
  matchOn: string[];
  description?: string;
}

/** The draft split at its current token: what came before it, the token, and whether a quote is still open. */
function splitDraft(draft: string): { before: string; token: string; quoteOpen: boolean } {
  let start = 0;
  let quoteOpen = false;
  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft.charAt(i);
    if (ch === '"') quoteOpen = !quoteOpen;
    else if (!quoteOpen && /\s/.test(ch)) start = i + 1;
  }
  return { before: draft.slice(0, start), token: draft.slice(start), quoteOpen };
}

/** `[-]field:` of the current token, when it is a value being typed for a known field. */
function parseValueToken(token: string): { neg: string; field: SearchField; value: string } | null {
  const m = /^(-?)([a-z]+):(.*)$/.exec(token);
  const field = m?.[2];
  return m && field && isField(field) ? { neg: m[1] ?? '', field, value: m[3] ?? '' } : null;
}

/** The field whose values are being typed, so the page knows which list to load. */
export function valueField(draft: string): SearchField | null {
  return parseValueToken(splitDraft(draft).token)?.field ?? null;
}

/** Items whose text starts with `term` first, then those that merely contain it, each group in the order given. */
function rank<T>(items: readonly T[], term: string, texts: (item: T) => string[]): T[] {
  if (term === '') return [...items];
  const needle = term.toLowerCase();
  const starting: T[] = [];
  const containing: T[] = [];
  for (const item of items) {
    const haystack = texts(item).map((text) => text.toLowerCase());
    if (haystack.some((text) => text.startsWith(needle))) starting.push(item);
    else if (haystack.some((text) => text.includes(needle))) containing.push(item);
  }
  return [...starting, ...containing];
}

const matchRange = (label: string, term: string): { start: number; end: number } | undefined => {
  const start = term === '' ? -1 : label.toLowerCase().indexOf(term.toLowerCase());
  return start < 0 ? undefined : { start, end: start + term.length };
};

function dynamicOptions(field: SearchField, ctx: SuggestContext): Option[] {
  const options: Option[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, matchOn: string[], description?: string) => {
    const label = quoteValue(value);
    if (label === null || seen.has(label)) return;
    seen.add(label);
    options.push({ label, matchOn, description });
  };
  if (field === 'api') {
    for (const api of ctx.apis ?? []) {
      const [name] = strings(api.name);
      add(api.slug, strings(api.slug, name), name === api.slug ? undefined : name);
    }
  } else if (field === 'key') {
    for (const key of ctx.keys ?? []) add(key.name, strings(key.name), strings(key.apiName)[0]);
  } else {
    for (const path of ctx.paths ?? []) add(path, strings(path));
  }
  return options;
}

/** The options for one field's values, and the text of the value that is already settled (before the last comma). */
function valueOptions(field: SearchField, value: string, ctx: SuggestContext): { head: string; term: string; options: Option[] } {
  const none = { head: '', term: '', options: [] };
  switch (field) {
    case 'status':
      if (value.includes('"') || value.includes(',')) return none;
      return {
        head: '',
        term: value,
        options: STATUS_VALUES.map((v) => ({ label: v, matchOn: [v], description: ctx.statusMeaning(v) })),
      };
    case 'latency':
      if (value.includes('"')) return none;
      return {
        head: '',
        term: value,
        options: LATENCIES_MS.map((ms) => ({ label: `>${String(ms)}`, matchOn: [`>${String(ms)}`], description: ctx.latencyOver(ms) })),
      };
    case 'method': {
      if (value.includes('"')) return none;
      const comma = value.lastIndexOf(',');
      const chosen = value.slice(0, comma + 1).toUpperCase().split(',');
      return {
        head: value.slice(0, comma + 1),
        term: value.slice(comma + 1),
        options: METHODS.filter((m) => !chosen.includes(m)).map((m) => ({ label: m, matchOn: [m] })),
      };
    }
    case 'reqh':
    case 'resh':
      // After `=` the person is typing a header VALUE, which is free text.
      if (value.includes('"') || value.includes('=')) return none;
      return { head: '', term: value, options: HEADERS.map((h) => ({ label: h, matchOn: [h] })) };
    case 'api':
    case 'key':
    case 'path':
    case 'route':
      // These are names, which may need quotes: look through an opening (and a closing) one.
      return { head: '', term: value.replace(/^"/, '').replace(/"$/, ''), options: dynamicOptions(field, ctx) };
    case 'body':
    case 'req':
    case 'res':
      return none;
  }
}

/** Rows for the draft as it stands. Accepting a field keeps typing; accepting a value commits the token as a chip. */
export function suggest(draft: string, ctx: SuggestContext): ChipInputSuggestion[] {
  const { before, token, quoteOpen } = splitDraft(draft);
  const parsed = parseValueToken(token);

  if (!parsed) {
    if (quoteOpen) return [];
    const neg = token.startsWith('-') ? '-' : '';
    const term = token.slice(neg.length);
    return rank(SEARCH_FIELDS, term, (field) => [field]).map((field) => ({
      id: `field:${field}`,
      label: `${field}:`,
      description: ctx.fieldDescription(field),
      apply: `${before}${neg}${field}:`,
      match: matchRange(`${field}:`, term),
    }));
  }

  const { neg, field, value } = parsed;
  const { head, term, options } = valueOptions(field, value, ctx);
  const cap = field === 'api' || field === 'key' || field === 'path' || field === 'route' ? MAX_DYNAMIC_SUGGESTIONS : Infinity;
  const rows: ChipInputSuggestion[] = [];
  for (const option of rank(options, term, (o) => o.matchOn)) {
    const filter = `${neg}${field}:${head}${option.label}`;
    if (!parseToken(filter).ok) continue;
    rows.push({
      id: filter,
      label: option.label,
      description: option.description,
      apply: `${before}${filter}`,
      commit: true,
      match: matchRange(option.label, term),
    });
    if (rows.length >= cap) break;
  }
  return rows;
}

export type DraftHint = { kind: 'term' } | { kind: 'commonWord'; term: string };

/**
 * What to tell the person typing a body search: pick a real word, and a warning when the one typed is
 * found in almost every body (the parser would reject it). `null` for every other field.
 */
export function draftHint(draft: string): DraftHint | null {
  const { token } = splitDraft(draft);
  if (!/^-?(body|req|res):/.test(token)) return null;
  const parsed = parseToken(token);
  if (!parsed.ok && parsed.error.code === 'commonWord') {
    // An unterminated quote is still in the value the parser reports.
    return { kind: 'commonWord', term: String(parsed.error.params.term ?? '').replace(/^"/, '') };
  }
  return { kind: 'term' };
}
