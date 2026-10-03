import { describe, expect, it } from 'vitest';
import { parseToken, quoteValue, tokenize, type SearchClause } from './traffic-search';

const clause = (raw: string): SearchClause => {
  const parsed = parseToken(raw);
  if (!parsed.ok) throw new Error(`${raw}: ${parsed.error.code}`);
  return parsed.clause;
};
const errorCode = (raw: string) => {
  const parsed = parseToken(raw);
  return parsed.ok ? null : parsed.error.code;
};

/**
 * Pinned to the API: the same rows appear in `traffic-search.validate.spec.ts` as JSON the validator
 * must accept, so a change to one side's shape fails a test on the other.
 */
const CONTRACT: [string, SearchClause][] = [
  ['status:>=500', { kind: 'status', neg: false, match: { type: 'cmp', op: '>=', value: 500 } }],
  ['status:5xx', { kind: 'status', neg: false, match: { type: 'range', from: 500, to: 599 } }],
  ['status:200-299', { kind: 'status', neg: false, match: { type: 'range', from: 200, to: 299 } }],
  ['-status:404,429', { kind: 'status', neg: true, match: { type: 'in', values: [404, 429] } }],
  ['latency:>800', { kind: 'latency', neg: false, op: '>', value: 800 }],
  ['latency:800', { kind: 'latency', neg: false, op: '>=', value: 800 }],
  ['method:post,put', { kind: 'method', neg: false, values: ['POST', 'PUT'] }],
  ['path:/orders', { kind: 'path', neg: false, value: '/orders' }],
  ['route:/orders', { kind: 'route', neg: false, value: '/orders' }],
  ['-route:/', { kind: 'route', neg: true, value: '/' }],
  ['api:orders-api', { kind: 'api', neg: false, value: 'orders-api' }],
  ['key:qbus-web', { kind: 'key', neg: false, value: 'qbus-web' }],
  ['reqh:X-Request-Id=abc', { kind: 'header', neg: false, side: 'req', name: 'x-request-id', value: 'abc' }],
  ['resh:x-cache', { kind: 'header', neg: false, side: 'res', name: 'x-cache' }],
  ['body:"insufficient funds"', { kind: 'body', neg: false, side: 'any', value: 'insufficient funds' }],
  ['res:refused', { kind: 'body', neg: false, side: 'res', value: 'refused' }],
  ['timeout', { kind: 'body', neg: false, side: 'any', value: 'timeout' }],
];

/**
 * The bounds, pinned on both sides. `traffic-search.validate.spec.ts` in the API holds the SAME two tables, keyed
 * by the clause the API receives instead of the text typed: the web parser must refuse every shape the API
 * answers with 400 (a chip that looks fine and then fails the whole search), and accept every edge the API
 * accepts. Change a row here and the same row there, or one side stops being checked against the other.
 */
const TEN = Array.from({ length: 10 }, (_, i) => 200 + i);
const ELEVEN = Array.from({ length: 11 }, (_, i) => 200 + i);
const REJECTED: [string, string, Record<string, unknown>][] = [
  ['a status above 599', 'status:>=700', { kind: 'status', match: { type: 'cmp', op: '>=', value: 700 } }],
  ['a status of 000', 'status:>=000', { kind: 'status', match: { type: 'cmp', op: '>=', value: 0 } }],
  ['a status under 100', 'status:<099', { kind: 'status', match: { type: 'cmp', op: '<', value: 99 } }],
  ['an exact code under 100', 'status:099', { kind: 'status', match: { type: 'in', values: [99] } }],
  ['an exact code above 599', 'status:600', { kind: 'status', match: { type: 'in', values: [600] } }],
  ['a range ending above 599', 'status:600-700', { kind: 'status', match: { type: 'range', from: 600, to: 700 } }],
  ['a range starting under 100', 'status:050-200', { kind: 'status', match: { type: 'range', from: 50, to: 200 } }],
  ['a range that ends before it starts', 'status:300-200', { kind: 'status', match: { type: 'range', from: 300, to: 200 } }],
  ['eleven status codes', `status:${ELEVEN.join(',')}`, { kind: 'status', match: { type: 'in', values: ELEVEN } }],
  ['a latency over an hour', 'latency:3600001', { kind: 'latency', op: '>=', value: 3_600_001 }],
  ['a latency with an operator over an hour', 'latency:>3600001', { kind: 'latency', op: '>', value: 3_600_001 }],
  ['eight methods', 'method:GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS,TRACE', { kind: 'method', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] }],
  ['a one-letter method', 'method:G', { kind: 'method', values: ['G'] }],
  ['a header name with a space', 'reqh:bad name', { kind: 'header', side: 'req', name: 'bad name' }],
  ['a header name over 64 characters', `reqh:${'h'.repeat(65)}`, { kind: 'header', side: 'req', name: 'h'.repeat(65) }],
  ['a value over 200 characters', `key:${'k'.repeat(201)}`, { kind: 'key', value: 'k'.repeat(201) }],
  ['a route over 200 characters', `route:${'r'.repeat(201)}`, { kind: 'route', value: 'r'.repeat(201) }],
  ['a path under 3 letters or digits', 'path:/a', { kind: 'path', value: '/a' }],
  ['a body term under 3 letters or digits', 'body:ab', { kind: 'body', side: 'any', value: 'ab' }],
  ['a body made only of common words', 'body:"true false"', { kind: 'body', side: 'any', value: 'true false' }],
];
/** The edges that are still fine: refusing one of these would be the web side being stricter than the API. */
const EDGES: [string, string, Record<string, unknown>][] = [
  ['the lowest status', 'status:>=100', { kind: 'status', neg: false, match: { type: 'cmp', op: '>=', value: 100 } }],
  ['the highest status', 'status:<=599', { kind: 'status', neg: false, match: { type: 'cmp', op: '<=', value: 599 } }],
  ['the widest status range', 'status:100-599', { kind: 'status', neg: false, match: { type: 'range', from: 100, to: 599 } }],
  ['a one-code range', 'status:404-404', { kind: 'status', neg: false, match: { type: 'range', from: 404, to: 404 } }],
  ['ten status codes', `status:${TEN.join(',')}`, { kind: 'status', neg: false, match: { type: 'in', values: TEN } }],
  ['the lowest latency', 'latency:0', { kind: 'latency', neg: false, op: '>=', value: 0 }],
  ['an hour of latency', 'latency:<=3600000', { kind: 'latency', neg: false, op: '<=', value: 3_600_000 }],
  ['seven methods', 'method:GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS', { kind: 'method', neg: false, values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }],
  ['a 200-character key', `key:${'k'.repeat(200)}`, { kind: 'key', neg: false, value: 'k'.repeat(200) }],
  ['a 64-character header name', `reqh:${'h'.repeat(64)}`, { kind: 'header', neg: false, side: 'req', name: 'h'.repeat(64) }],
];

describe('tokenize', () => {
  it('keeps a quoted phrase together and splits on other whitespace', () => {
    expect(tokenize('status:>=500  body:"insufficient funds"\tmethod:POST')).toEqual([
      'status:>=500',
      'body:"insufficient funds"',
      'method:POST',
    ]);
  });

  it('returns nothing for blank input and keeps an unterminated quote as one token', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('body:"still typing')).toEqual(['body:"still typing']);
  });
});

describe('quoteValue', () => {
  it('leaves a plain value bare and quotes one with whitespace', () => {
    expect(quoteValue('payments')).toBe('payments');
    expect(quoteValue('My API')).toBe('"My API"');
  });

  it('refuses what the grammar cannot carry: an empty value and a double quote', () => {
    expect(quoteValue('')).toBeNull();
    expect(quoteValue('say "hi"')).toBeNull();
  });

  it.each([['carriage return', '/a\rb'], ['line feed', '/a\nb'], ['line separator', '/a\u2028b'], ['paragraph separator', '/a\u2029b']])(
    'refuses a value with a %s: the parser\'s `.` does not match one, so quoting it would read back as a body search',
    (_name, value) => {
      expect(quoteValue(value)).toBeNull();
      expect(quoteValue(`${value} c`)).toBeNull();
    },
  );

  it('says no, rather than throwing, to something that is not a string (a name the API left null)', () => {
    expect(quoteValue(null)).toBeNull();
    expect(quoteValue(undefined)).toBeNull();
    expect(quoteValue(42)).toBeNull();
  });

  it.each(['payments', 'My API', 'a  b', 'tab\there'])('%j round-trips through tokenize and parseToken', (value) => {
    const quoted = quoteValue(value);
    expect(quoted).not.toBeNull();
    const tokens = tokenize(`status:5xx api:${quoted ?? ''} method:GET`);
    expect(tokens).toHaveLength(3);
    expect(clause(tokens[1] ?? '')).toEqual({ kind: 'api', neg: false, value });
  });
});

describe('parseToken', () => {
  it.each(CONTRACT)('%s', (raw, expected) => {
    expect(clause(raw)).toEqual(expected);
  });

  it.each([
    ['foo:bar', 'unknownField'],
    ['status:', 'needsValue'],
    ['status:99', 'status'],
    ['status:6xx', 'status'],
    ['latency:fast', 'latency'],
    ['method:get!', 'method'],
    ['reqh:bad name=1', 'headerName'],
    ['reqh:x-a=', 'needsValue'],
    ['json:user.id=1', 'unknownField'],
    ['regex:E4[0-9]{2}', 'unknownField'],
    ['body~fund', 'unsupportedOperator'],
    ['path~ord', 'unsupportedOperator'],
    ['id', 'termTooShort'],
    ['data', 'commonWord'],
    ['body:DATA', 'commonWord'],
    ['body:"true false"', 'commonWord'],
    ['body:ab', 'termTooShort'],
    ['body:"--- ---"', 'termTooShort'],
    ['body:"a b c"', 'termTooShort'],
    ['body:"data x y"', 'commonWord'],
    ['path:/a', 'termTooShort'],
    ['route:', 'needsValue'],
    [`route:${'r'.repeat(201)}`, 'tooLong'],
    [`key:${'k'.repeat(201)}`, 'tooLong'],
  ])('%s is refused as %s', (raw, code) => {
    expect(errorCode(raw)).toBe(code);
  });

  it.each(['route:/', 'route:/me', 'route:/a', '-route:/v1'])('%s is accepted: an exact path needs no minimum length', (raw) => {
    expect(errorCode(raw)).toBeNull();
  });

  it('route: and path: read the same text differently: one exact, one a prefix', () => {
    expect(clause('route:/orders')).toEqual({ kind: 'route', neg: false, value: '/orders' });
    expect(clause('path:/orders')).toEqual({ kind: 'path', neg: false, value: '/orders' });
    expect(errorCode('path:/me')).toBe('termTooShort');
  });

  it.each(REJECTED)('refuses %s, as the API does: %s', (_label, token) => {
    expect(parseToken(token).ok, token).toBe(false);
  });

  it.each(EDGES)('accepts %s, the edge the API still takes: %s', (_label, token, expected) => {
    expect(clause(token), token).toEqual(expected);
  });

  it('a common word inside a more specific phrase is fine', () => {
    expect(errorCode('body:"insufficient funds status"')).toBeNull();
  });

  it('carries the numbers a translated message needs', () => {
    expect(parseToken('body:ab')).toMatchObject({ ok: false, error: { params: { min: 3 } } });
    expect(parseToken('foo:bar')).toMatchObject({ ok: false, error: { params: { field: 'foo' } } });
  });

  it('counts letters in any script, so a short Arabic term is too short and a full word is fine', () => {
    expect(errorCode('body:مل')).toBe('termTooShort');
    expect(errorCode('body:المال')).toBeNull();
  });
});
