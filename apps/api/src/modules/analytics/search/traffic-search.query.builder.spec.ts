import { trafficSearchQuery } from './traffic-search.query.builder';
import { FULLTEXT_ANY, FULLTEXT_REQ, FULLTEXT_RES } from './traffic-search.sql';
import { validateSearchRequest } from './traffic-search.validate';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const ids = ['tyk-a', 'tyk-b'];
const resolveApi = (value: string): string[] => (value === 'orders-api' ? ['tyk-a'] : []);

function build(body: Record<string, unknown>) {
  const request = validateSearchRequest(body);
  const q = trafficSearchQuery({ request, tykApiIds: ids, resolveApi, now: NOW });
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
}

describe('trafficSearchQuery', () => {
  it('always starts with the tenant scope and the window, even with no clauses', () => {
    const { sql, values } = build({ range: '24h' });
    expect(sql).toContain('WHERE apiid = ANY($1::text[]) AND ts >= $2 ORDER BY ts DESC, id DESC LIMIT $3');
    expect(values[0]).toEqual(ids);
    expect(values[1]).toEqual(new Date('2026-09-28T12:00:00.000Z'));
    expect(values[2]).toBe(51);
  });

  it('fetches one extra row so "has more" needs no COUNT', () => {
    expect(build({ limit: 10 }).values.at(-1)).toBe(11);
  });

  it('keeps the cursor timestamp as text, so microseconds survive paging', () => {
    expect(build({ cursor: { ts: '2026-09-29T10:06:17.159317Z', id: '5' } }).values[2]).toBe('2026-09-29T10:06:17.159317Z');
  });

  it('selects the timestamp as microsecond text for the next cursor', () => {
    expect(build({}).sql).toContain(`to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_iso`);
  });

  it('never selects the body columns for the list', () => {
    const { sql } = build({});
    expect(sql).not.toMatch(/req_body|res_body|req_headers|res_headers/);
  });

  it('binds every value: hostile text appears in the parameters and never in the SQL', () => {
    const evil = `'; DROP TABLE og_traffic_search; --`;
    const { sql, values } = build({
      clauses: [
        { kind: 'key', value: evil },
        { kind: 'body', side: 'res', value: 'weird timeout' },
        { kind: 'path', value: evil },
        { kind: 'header', side: 'req', name: 'x-a', value: evil },
      ],
    });
    expect(sql).not.toContain('DROP');
    expect(values).toContain(evil);
  });

  it('compiles each kind to its predicate', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ kind: 'status', match: { type: 'cmp', op: '>=', value: 500 } }, /status >= \$3/],
      [{ kind: 'status', match: { type: 'range', from: 200, to: 299 } }, /status BETWEEN \$3 AND \$4/],
      [{ kind: 'status', match: { type: 'in', values: [404, 429] } }, /status = ANY\(\$3::int\[\]\)/],
      [{ kind: 'latency', op: '>', value: 800 }, /latency_ms > \$3/],
      [{ kind: 'method', values: ['GET', 'POST'] }, /method = ANY\(\$3::text\[\]\)/],
      [{ kind: 'path', value: '/orders' }, /path LIKE \$3 ESCAPE/],
      [{ kind: 'key', value: 'qbus-web' }, /key_alias = \$3/],
      [{ kind: 'header', side: 'req', name: 'x-request-id', value: 'abc' }, /req_headers @> \$3::jsonb/],
      [{ kind: 'header', side: 'res', name: 'x-cache' }, /res_headers @\? \$3::jsonpath/],
    ];
    for (const [c, expected] of cases) expect(build({ clauses: [c] }).sql).toMatch(expected);
  });

  describe('body word search', () => {
    it('emits the exact expression the GIN index is built on, so the planner can use it', () => {
      const { sql } = build({ clauses: [{ kind: 'body', side: 'any', value: 'insufficient funds' }] });
      expect(sql).toContain(`${FULLTEXT_ANY} @@ phraseto_tsquery('simple', $3)`);
    });

    it('a side-specific search keeps the index probe and adds an exact recheck on that side', () => {
      const res = build({ clauses: [{ kind: 'body', side: 'res', value: 'timeout' }] }).sql;
      expect(res).toContain(`(${FULLTEXT_ANY} @@ phraseto_tsquery('simple', $3) AND ${FULLTEXT_RES} @@ phraseto_tsquery('simple', $4))`);
      const req = build({ clauses: [{ kind: 'body', side: 'req', value: 'timeout' }] }).sql;
      expect(req).toContain(`AND ${FULLTEXT_REQ} @@`);
    });

    it('binds the phrase twice for a side search, and once for either side', () => {
      expect(build({ clauses: [{ kind: 'body', side: 'res', value: 'timeout' }] }).values.slice(2)).toEqual(['timeout', 'timeout', 51]);
      expect(build({ clauses: [{ kind: 'body', side: 'any', value: 'timeout' }] }).values.slice(2)).toEqual(['timeout', 51]);
    });
  });

  it('escapes LIKE wildcards in a typed path prefix', () => {
    expect(build({ clauses: [{ kind: 'path', value: '/ab_c%' }] }).values[2]).toBe('/ab\\_c\\%%');
  });

  it('a negated clause keeps rows where the column is NULL', () => {
    const { sql } = build({ clauses: [{ kind: 'header', neg: true, side: 'res', name: 'x-cache' }] });
    expect(sql).toContain('NOT COALESCE((res_headers @? $3::jsonpath), false)');
  });

  it('api: resolves only within the tenant, and an unknown name matches nothing', () => {
    expect(build({ clauses: [{ kind: 'api', value: 'orders-api' }] }).values[2]).toEqual(['tyk-a']);
    expect(build({ clauses: [{ kind: 'api', value: 'someone-elses' }] }).values[2]).toEqual([]);
  });

  it('an empty tenant scope stays a bound empty array, so nothing can match', () => {
    const request = validateSearchRequest({});
    const q = trafficSearchQuery({ request, tykApiIds: [], resolveApi, now: NOW });
    expect(q.values[0]).toEqual([]);
  });

  it('keyset: pages after the cursor with (ts, id)', () => {
    const { sql, values } = build({ cursor: { ts: '2026-09-29T10:06:17.159Z', id: '900' } });
    expect(sql).toContain('(ts, id) < ($3::timestamptz, $4::bigint)');
    expect(values[2]).toBe('2026-09-29T10:06:17.159Z');
    expect(values[3]).toBe('900');
  });

  it('numbers the parameters in step with the clauses when a range takes two', () => {
    const { sql } = build({
      clauses: [
        { kind: 'status', match: { type: 'range', from: 500, to: 599 } },
        { kind: 'latency', op: '>', value: 5 },
      ],
    });
    expect(sql).toContain('status BETWEEN $3 AND $4 AND latency_ms > $5');
  });

  it.each([
    ['1h', '2026-09-29T11:00:00.000Z'],
    ['7d', '2026-09-22T12:00:00.000Z'],
    ['30d', '2026-08-30T12:00:00.000Z'],
  ])('window %s starts at %s', (range, from) => {
    expect(build({ range }).values[1]).toEqual(new Date(from));
  });
});
