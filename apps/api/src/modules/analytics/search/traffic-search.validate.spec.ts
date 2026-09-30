import { validateSearchRequest, SearchValidationError } from './traffic-search.validate';
import { SEARCH_LIMITS } from './traffic-search.types';

const clause = (c: Record<string, unknown>) => validateSearchRequest({ clauses: [c] }).clauses[0];
const rejects = (input: unknown, message: RegExp) => {
  expect(() => validateSearchRequest(input)).toThrow(SearchValidationError);
  expect(() => validateSearchRequest(input)).toThrow(message);
};

describe('validateSearchRequest', () => {
  it('defaults to 24h, no clauses, the default page size and no cursor', () => {
    expect(validateSearchRequest({})).toEqual({ range: '24h', clauses: [], limit: SEARCH_LIMITS.defaultPageSize });
  });

  it('accepts one of each clause kind and defaults neg to false', () => {
    const all = [
      { kind: 'status', match: { type: 'cmp', op: '>=', value: 500 } },
      { kind: 'status', neg: true, match: { type: 'in', values: [404, 429] } },
      { kind: 'status', match: { type: 'range', from: 200, to: 299 } },
      { kind: 'latency', op: '>', value: 800 },
      { kind: 'method', values: ['GET', 'POST'] },
      { kind: 'path', mode: 'prefix', value: '/orders' },
      { kind: 'path', mode: 'glob', value: '*fund*' },
      { kind: 'api', value: 'orders-api' },
      { kind: 'key', value: 'qbus-web' },
      { kind: 'header', side: 'req', name: 'x-request-id', value: 'abc' },
      { kind: 'header', side: 'res', name: 'x-cache' },
      { kind: 'body', side: 'any', mode: 'word', value: 'insufficient funds' },
      { kind: 'json', path: ['user', 'id'], value: '4242' },
      { kind: 'regex', value: 'E4[0-9]{2}' },
    ];
    const parsed = [all.slice(0, 8), all.slice(8)].flatMap((clauses) => validateSearchRequest({ clauses }).clauses);
    expect(parsed).toHaveLength(14);
    expect(parsed[0]).toMatchObject({ neg: false });
    expect(parsed[1]).toMatchObject({ neg: true });
  });

  it('accepts the largest page and a well-formed cursor', () => {
    const request = validateSearchRequest({ range: '7d', limit: 100, cursor: { ts: '2026-09-29T10:06:17.159317Z', id: '123' } });
    expect(request).toMatchObject({ range: '7d', limit: 100, cursor: { ts: '2026-09-29T10:06:17.159317Z', id: '123' } });
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
    ['a body term under 3 characters', { clauses: [{ kind: 'body', side: 'any', mode: 'substring', value: 'ab' }] }, /at least 3/],
    ['a body term of only punctuation', { clauses: [{ kind: 'body', side: 'any', mode: 'word', value: '--- ---' }] }, /at least 3/],
    ['a path of only wildcards', { clauses: [{ kind: 'path', mode: 'glob', value: '**' }] }, /path needs/],
    ['a json path with a bracket', { clauses: [{ kind: 'json', path: ['items[0]'], value: '1' }] }, /json path/],
    ['a json path deeper than 6', { clauses: [{ kind: 'json', path: Array(7).fill('a'), value: '1' }] }, /json path/],
    ['a value over 200 characters', { clauses: [{ kind: 'key', value: 'k'.repeat(201) }] }, /longer than 200/],
    ['a short regex', { clauses: [{ kind: 'regex', value: 'a' }] }, /regex needs/],
    ['a cursor with a bad id', { cursor: { ts: '2026-09-29T10:06:17Z', id: '1; DROP' } }, /cursor is malformed/],
    ['a cursor with a bad timestamp', { cursor: { ts: 'yesterday', id: '1' } }, /cursor is malformed/],
  ])('rejects %s', (_label, input, message) => {
    rejects(input, message);
  });

  it('counts letters and digits in any script, so a short Arabic term is still too short', () => {
    rejects({ clauses: [{ kind: 'body', side: 'any', mode: 'word', value: 'مل' }] }, /at least 3/);
    expect(clause({ kind: 'body', side: 'any', mode: 'word', value: 'المال' })).toMatchObject({ kind: 'body' });
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
    { kind: 'path', neg: false, mode: 'prefix', value: '/orders' },
    { kind: 'path', neg: false, mode: 'glob', value: '*fund*' },
    { kind: 'api', neg: false, value: 'orders-api' },
    { kind: 'key', neg: false, value: 'qbus-web' },
    { kind: 'header', neg: false, side: 'req', name: 'x-request-id', value: 'abc' },
    { kind: 'header', neg: false, side: 'res', name: 'x-cache' },
    { kind: 'body', neg: false, side: 'any', mode: 'word', value: 'insufficient funds' },
    { kind: 'body', neg: false, side: 'res', mode: 'substring', value: 'fund' },
    { kind: 'json', neg: false, path: ['user', 'id'], value: '4242' },
    { kind: 'regex', neg: false, value: 'E4[0-9]{2}' },
  ])('accepts what the web parser emits: $kind', (emitted) => {
    expect(validateSearchRequest({ clauses: [emitted] }).clauses[0]).toEqual(emitted);
  });
});
