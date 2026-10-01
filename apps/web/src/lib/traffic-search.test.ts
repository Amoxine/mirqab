import { describe, expect, it } from 'vitest';
import { parseToken, tokenize, type SearchClause } from './traffic-search';

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
    [`key:${'k'.repeat(201)}`, 'tooLong'],
  ])('%s is refused as %s', (raw, code) => {
    expect(errorCode(raw)).toBe(code);
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
