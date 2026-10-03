import { validateSearchRequest, SearchValidationError } from './traffic-search.validate';
import { SEARCH_LIMITS } from './traffic-search.types';

const clause = (c: Record<string, unknown>) => validateSearchRequest({ clauses: [c] }).clauses[0];
const rejects = (input: unknown, message: RegExp) => {
  expect(() => validateSearchRequest(input)).toThrow(SearchValidationError);
  expect(() => validateSearchRequest(input)).toThrow(message);
};
const body = (value: string, side = 'any') => ({ kind: 'body', side, value });

/**
 * The bounds, pinned on both sides. `apps/web/src/lib/traffic-search.test.ts` holds the SAME two tables, keyed by
 * the text typed instead of the clause sent: whatever the API answers with 400 the web parser must refuse before
 * it ever reaches here (a chip that looks fine and then fails the whole search), and every edge accepted here
 * must be accepted there. Change a row here and the same row there.
 */
const TEN = Array.from({ length: 10 }, (_, i) => 200 + i);
const ELEVEN = Array.from({ length: 11 }, (_, i) => 200 + i);
const REJECTED: [string, Record<string, unknown>][] = [
  ['a status above 599', { kind: 'status', match: { type: 'cmp', op: '>=', value: 700 } }],
  ['a status of 000', { kind: 'status', match: { type: 'cmp', op: '>=', value: 0 } }],
  ['a status under 100', { kind: 'status', match: { type: 'cmp', op: '<', value: 99 } }],
  ['an exact code under 100', { kind: 'status', match: { type: 'in', values: [99] } }],
  ['an exact code above 599', { kind: 'status', match: { type: 'in', values: [600] } }],
  ['a range ending above 599', { kind: 'status', match: { type: 'range', from: 600, to: 700 } }],
  ['a range starting under 100', { kind: 'status', match: { type: 'range', from: 50, to: 200 } }],
  ['a range that ends before it starts', { kind: 'status', match: { type: 'range', from: 300, to: 200 } }],
  ['eleven status codes', { kind: 'status', match: { type: 'in', values: ELEVEN } }],
  ['a latency over an hour', { kind: 'latency', op: '>=', value: 3_600_001 }],
  ['a latency with an operator over an hour', { kind: 'latency', op: '>', value: 3_600_001 }],
  ['eight methods', { kind: 'method', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] }],
  ['a one-letter method', { kind: 'method', values: ['G'] }],
  ['a header name with a space', { kind: 'header', side: 'req', name: 'bad name' }],
  ['a header name over 64 characters', { kind: 'header', side: 'req', name: 'h'.repeat(65) }],
  ['a value over 200 characters', { kind: 'key', value: 'k'.repeat(201) }],
  ['a route over 200 characters', { kind: 'route', value: 'r'.repeat(201) }],
  ['a path under 3 letters or digits', { kind: 'path', value: '/a' }],
  ['a body term under 3 letters or digits', { kind: 'body', side: 'any', value: 'ab' }],
  ['a body made only of common words', { kind: 'body', side: 'any', value: 'true false' }],
];
const EDGES: [string, Record<string, unknown>][] = [
  ['the lowest status', { kind: 'status', neg: false, match: { type: 'cmp', op: '>=', value: 100 } }],
  ['the highest status', { kind: 'status', neg: false, match: { type: 'cmp', op: '<=', value: 599 } }],
  ['the widest status range', { kind: 'status', neg: false, match: { type: 'range', from: 100, to: 599 } }],
  ['a one-code range', { kind: 'status', neg: false, match: { type: 'range', from: 404, to: 404 } }],
  ['ten status codes', { kind: 'status', neg: false, match: { type: 'in', values: TEN } }],
  ['the lowest latency', { kind: 'latency', neg: false, op: '>=', value: 0 }],
  ['an hour of latency', { kind: 'latency', neg: false, op: '<=', value: 3_600_000 }],
  ['seven methods', { kind: 'method', neg: false, values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }],
  ['a 200-character key', { kind: 'key', neg: false, value: 'k'.repeat(200) }],
  ['a 64-character header name', { kind: 'header', neg: false, side: 'req', name: 'h'.repeat(64) }],
];

describe('validateSearchRequest', () => {
  it('defaults to 24h, no clauses, the default page size and no cursor', () => {
    expect(validateSearchRequest({})).toEqual({ range: '24h', clauses: [], limit: SEARCH_LIMITS.defaultPageSize });
  });

  it('accepts one of each lean clause kind and defaults neg to false', () => {
    const request = validateSearchRequest({
      clauses: [
        { kind: 'status', match: { type: 'cmp', op: '>=', value: 500 } },
        { kind: 'status', neg: true, match: { type: 'in', values: [404, 429] } },
        { kind: 'status', match: { type: 'range', from: 200, to: 299 } },
        { kind: 'latency', op: '>', value: 800 },
        { kind: 'method', values: ['GET', 'POST'] },
        { kind: 'path', value: '/orders' },
        { kind: 'api', value: 'orders-api' },
        { kind: 'key', value: 'qbus-web' },
      ],
    });
    expect(request.clauses).toHaveLength(8);
    expect(request.clauses[0]).toMatchObject({ neg: false });
    expect(request.clauses[1]).toMatchObject({ neg: true });
    const more = validateSearchRequest({
      clauses: [
        { kind: 'header', side: 'req', name: 'x-request-id', value: 'abc' },
        { kind: 'header', side: 'res', name: 'x-cache' },
        body('insufficient funds'),
        { kind: 'route', value: '/orders' },
      ],
    });
    expect(more.clauses).toHaveLength(4);
  });

  describe('route: the exact path', () => {
    it.each(['/', '/me', '/orders', '/orders/{id}', 'r'.repeat(SEARCH_LIMITS.maxValueLength)])(
      'accepts %s, however short: unlike a prefix it needs no minimum length',
      (value) => {
        expect(clause({ kind: 'route', value })).toEqual({ kind: 'route', neg: false, value });
      },
    );

    it('can be negated, and drops keys it does not know', () => {
      expect(clause({ kind: 'route', neg: true, value: '/orders', mode: 'prefix' })).toEqual({ kind: 'route', neg: true, value: '/orders' });
    });

    it.each([
      ['an empty value', { kind: 'route', value: '' }, /route needs a value/],
      ['a missing value', { kind: 'route' }, /route needs a value/],
      ['a non-string value', { kind: 'route', value: 5 }, /route needs a value/],
      ['a value over 200 characters', { kind: 'route', value: 'r'.repeat(201) }, /longer than 200/],
    ])('refuses %s', (_label, c, message) => {
      rejects({ clauses: [c] }, message);
    });
  });

  it('accepts the largest page and a well-formed cursor', () => {
    const request = validateSearchRequest({ range: '7d', limit: 100, cursor: { ts: '2026-09-29T10:06:17.159317Z', id: '123' } });
    expect(request).toMatchObject({ range: '7d', limit: 100, cursor: { ts: '2026-09-29T10:06:17.159317Z', id: '123' } });
    const edge = { ts: '2028-02-29T23:59:59.999999Z', id: '9223372036854775807' }; // a leap day, the bigint max
    expect(validateSearchRequest({ cursor: edge }).cursor).toEqual(edge);
  });

  it('drops keys it does not know, so nothing extra reaches the builder', () => {
    expect(clause({ kind: 'latency', op: '>', value: 5, sql: 'DROP TABLE x' })).toEqual({
      kind: 'latency',
      neg: false,
      op: '>',
      value: 5,
    });
  });

  it.each([
    ['json', { kind: 'json', path: ['a'], value: '1' }],
    ['regex', { kind: 'regex', value: 'E4[0-9]{2}' }],
  ])('refuses the %s kind, which is not in the lean core', (_kind, input) => {
    rejects({ clauses: [input] }, /Unknown filter kind/);
  });

  it('ignores a mode the old grammar had: body is always a word search, path always a prefix', () => {
    expect(clause({ ...body('insufficient funds'), mode: 'substring' })).toEqual({ kind: 'body', neg: false, side: 'any', value: 'insufficient funds' });
    expect(clause({ kind: 'path', mode: 'glob', value: '*orders*' })).toEqual({ kind: 'path', neg: false, value: '*orders*' });
  });

  it.each([
    ['a non-object body', 'nope', /must be an object/],
    ['an unknown range', { range: '90d' }, /range must be/],
    ['clauses that are not a list', { clauses: {} }, /must be a list/],
    ['too many clauses', { clauses: Array.from({ length: 9 }, () => ({ kind: 'key', value: 'k' })) }, /At most 8/],
    ['a page size of 0', { limit: 0 }, /limit must be/],
    ['a page size over the cap', { limit: 101 }, /limit must be/],
    ['a fractional page size', { limit: 1.5 }, /limit must be/],
    ['an unknown kind', { clauses: [{ kind: 'sql', value: '1=1' }] }, /Unknown filter kind/],
    ['a non-object clause', { clauses: ['status:500'] }, /must be an object/],
    ['a non-boolean neg', { clauses: [{ kind: 'key', value: 'k', neg: 'yes' }] }, /neg must be/],
    ['a status outside 100-599', { clauses: [{ kind: 'status', match: { type: 'cmp', op: '>', value: 99 } }] }, /value must be/],
    ['an inverted status range', { clauses: [{ kind: 'status', match: { type: 'range', from: 500, to: 200 } }] }, /starts after/],
    ['an empty status list', { clauses: [{ kind: 'status', match: { type: 'in', values: [] } }] }, /status list/],
    ['an operator outside the four', { clauses: [{ kind: 'latency', op: '=; --', value: 1 }] }, /op must be/],
    ['a lower-case method', { clauses: [{ kind: 'method', values: ['get'] }] }, /method needs/],
    ['a header name with an injection', { clauses: [{ kind: 'header', side: 'req', name: 'x"]', value: 'v' }] }, /Header names/],
    ['an upper-case header name', { clauses: [{ kind: 'header', side: 'req', name: 'X-Cache' }] }, /Header names/],
    ['a bad header side', { clauses: [{ kind: 'header', side: 'both', name: 'x-a' }] }, /side must be/],
    ['a body term under 3 characters', { clauses: [body('ab')] }, /at least 3/],
    ['a body term of only punctuation', { clauses: [body('--- ---')] }, /at least 3/],
    ['a bad body side', { clauses: [body('funds', 'both')] }, /side must be/],
    ['a path under 3 characters', { clauses: [{ kind: 'path', value: '/a' }] }, /path needs/],
    ['a value over 200 characters', { clauses: [{ kind: 'key', value: 'k'.repeat(201) }] }, /longer than 200/],
    ['a cursor with a bad id', { cursor: { ts: '2026-09-29T10:06:17Z', id: '1; DROP' } }, /cursor is malformed/],
    ['a cursor with a bad timestamp', { cursor: { ts: 'yesterday', id: '1' } }, /cursor is malformed/],
    // Each of these passed the old shape check and reached Postgres, which answered with a 500.
    ['a cursor id past the bigint max', { cursor: { ts: '2026-09-29T10:06:17Z', id: '9223372036854775808' } }, /cursor is malformed/],
    ['a cursor on a day that does not exist', { cursor: { ts: '2026-02-30T10:00:00Z', id: '1' } }, /cursor is malformed/],
    ['a cursor at hour 25', { cursor: { ts: '2026-09-29T25:00:00Z', id: '1' } }, /cursor is malformed/],
    ['a cursor in year 0', { cursor: { ts: '0000-01-01T00:00:00Z', id: '1' } }, /cursor is malformed/],
  ])('rejects %s', (_label, input, message) => {
    rejects(input, message);
  });

  it.each(REJECTED)('refuses %s with a 400, which the web parser must also refuse', (_label, c) => {
    expect(() => validateSearchRequest({ clauses: [c] })).toThrow(SearchValidationError);
  });

  it.each(EDGES)('accepts %s, which the web parser must also accept', (_label, c) => {
    expect(validateSearchRequest({ clauses: [c] }).clauses[0]).toEqual(c);
  });

  describe('text Postgres cannot store is a 400, not a 500', () => {
    const NUL = 'a\u0000b';
    const LONE_HIGH = `a\uD83D`;
    const LONE_LOW = `\uDE00a`;
    const stringFields: [string, (v: string) => Record<string, unknown>][] = [
      ['a path', (value) => ({ kind: 'path', value: `/orders${value}` })],
      ['a route', (value) => ({ kind: 'route', value: `/orders${value}` })],
      ['an api', (value) => ({ kind: 'api', value })],
      ['a key', (value) => ({ kind: 'key', value })],
      ['a header value', (value) => ({ kind: 'header', side: 'req', name: 'x-a', value })],
      ['a body phrase', (value) => body(`refund declined ${value}`)],
    ];
    const bad: [string, string][] = [['a NUL', NUL], ['an unpaired high surrogate', LONE_HIGH], ['an unpaired low surrogate', LONE_LOW]];

    for (const [fieldName, make] of stringFields) {
      it.each(bad)(`${fieldName} with %s is refused`, (_name, value) => {
        rejects({ clauses: [make(value)] }, /cannot be searched for/);
      });
    }

    it('a real emoji (a proper pair) is fine', () => {
      expect(clause({ kind: 'key', value: 'k😀' })).toMatchObject({ kind: 'key', value: 'k😀' });
    });
  });

  describe('body terms', () => {
    it.each(['id', 'data', 'name', 'value', 'true', 'false', 'null', 'type', 'status', 'message', 'DATA', 'true false'])(
      'refuses the common word %s, which matches nearly every request',
      (word) => {
        rejects({ clauses: [body(word)] }, /almost every request|at least 3/);
      },
    );

    it('allows a common word inside a more specific phrase', () => {
      expect(clause(body('insufficient funds status'))).toMatchObject({ kind: 'body', value: 'insufficient funds status' });
    });

    it.each([
      ['short words that add up to 3 letters', 'a b c', /at least 3/],
      ['a stop word padded with short words', 'id x y', /at least 3/],
      ['a long stop word padded with short words', 'data x y', /almost every request/],
    ])('needs one word of 3+ letters that is not a stop word, not just 3 letters in the phrase: refuses %s', (_label, value, message) => {
      rejects({ clauses: [body(value)] }, message);
    });

    it('accepts short words beside one specific word', () => {
      expect(clause(body('ab cd refund'))).toMatchObject({ kind: 'body', value: 'ab cd refund' });
    });

    it('allows at most 3 body clauses', () => {
      const three = [body('timeout'), body('refused', 'res'), body('upstream', 'req')];
      expect(validateSearchRequest({ clauses: three }).clauses).toHaveLength(3);
      rejects({ clauses: [...three, body('gateway')] }, /At most 3 body-text/);
    });

    it('counts letters and digits in any script, so a short Arabic term is still too short', () => {
      rejects({ clauses: [body('مل')] }, /at least 3/);
      expect(clause(body('المال'))).toMatchObject({ kind: 'body' });
    });
  });

  /**
   * The clauses the web search bar emits for its example tokens (`apps/web/src/lib/traffic-search.test.ts`
   * holds the same table, keyed by the typed text). Each must pass through the validator unchanged, so
   * a change to either side's shape fails a test on the other.
   */
  it.each([
    { kind: 'status', neg: false, match: { type: 'cmp', op: '>=', value: 500 } },
    { kind: 'status', neg: false, match: { type: 'range', from: 500, to: 599 } },
    { kind: 'status', neg: true, match: { type: 'in', values: [404, 429] } },
    { kind: 'latency', neg: false, op: '>', value: 800 },
    { kind: 'method', neg: false, values: ['POST', 'PUT'] },
    { kind: 'path', neg: false, value: '/orders' },
    { kind: 'route', neg: false, value: '/orders' },
    { kind: 'route', neg: true, value: '/' },
    { kind: 'api', neg: false, value: 'orders-api' },
    { kind: 'key', neg: false, value: 'qbus-web' },
    { kind: 'header', neg: false, side: 'req', name: 'x-request-id', value: 'abc' },
    { kind: 'header', neg: false, side: 'res', name: 'x-cache' },
    { kind: 'body', neg: false, side: 'any', value: 'insufficient funds' },
    { kind: 'body', neg: false, side: 'res', value: 'timeout' },
  ])('accepts what the web parser emits: $kind', (emitted) => {
    expect(validateSearchRequest({ clauses: [emitted] }).clauses[0]).toEqual(emitted);
  });
});
