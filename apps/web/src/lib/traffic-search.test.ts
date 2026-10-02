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
