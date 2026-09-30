import { trafficSearchQuery } from './traffic-search.query.builder';
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

  it('never selects the body columns for the list', () => {
    const { sql } = build({});
    expect(sql).not.toMatch(/req_body|res_body|req_headers|res_headers|res_json/);
  });

  it('binds every value: hostile text appears in the parameters and never in the SQL', () => {
    const evil = `'; DROP TABLE og_traffic_search; --`;
    const { sql, values } = build({
      clauses: [
        { kind: 'key', value: evil },
        { kind: 'body', side: 'any', mode: 'substring', value: evil },
        { kind: 'body', side: 'res', mode: 'word', value: evil.replace(/[^a-z ]/gi, 'x') },
        { kind: 'regex', value: evil },
        { kind: 'path', mode: 'prefix', value: evil },
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
      [{ kind: 'path', mode: 'prefix', value: '/orders' }, /path LIKE \$3 ESCAPE/],
      [{ kind: 'path', mode: 'glob', value: '*fund*' }, /path ILIKE \$3 ESCAPE/],
      [{ kind: 'key', value: 'qbus-web' }, /key_alias = \$3/],
      [{ kind: 'header', side: 'req', name: 'x-request-id', value: 'abc' }, /req_headers @> \$3::jsonb/],
      [{ kind: 'header', side: 'res', name: 'x-cache' }, /res_headers @\? \$3::jsonpath/],
      [{ kind: 'body', side: 'res', mode: 'word', value: 'insufficient funds' }, /res_tsv @@ phraseto_tsquery\('simple', \$3\)/],
      [{ kind: 'body', side: 'req', mode: 'substring', value: 'fund' }, /req_body ILIKE \$3 ESCAPE/],
      [{ kind: 'regex', value: 'E4[0-9]{2}' }, /res_body ~\* \$3/],
    ];
    for (const [c, expected] of cases) expect(build({ clauses: [c] }).sql).toMatch(expected);
  });

  it('searches both sides for body:any, as an OR the planner can bitmap-combine', () => {
    const { sql } = build({ clauses: [{ kind: 'body', side: 'any', mode: 'word', value: 'insufficient' }] });
    expect(sql).toContain("(req_tsv @@ phraseto_tsquery('simple', $3) OR res_tsv @@ phraseto_tsquery('simple', $4))");
  });

  it('escapes LIKE wildcards in a typed path and turns * into %', () => {
    const { values } = build({ clauses: [{ kind: 'path', mode: 'glob', value: '*100%_done*' }] });
    expect(values[2]).toBe('%100\\%\\_done%');
    expect(build({ clauses: [{ kind: 'path', mode: 'prefix', value: '/a_b' }] }).values[2]).toBe('/a\\_b%');
  });

  it('escapes LIKE wildcards in a substring body search', () => {
    expect(build({ clauses: [{ kind: 'body', side: 'res', mode: 'substring', value: '50%_off' }] }).values[2]).toBe('%50\\%\\_off%');
  });

  it('json: probes both the text and the numeric encoding of a numeric-looking value', () => {
    const { sql, values } = build({ clauses: [{ kind: 'json', path: ['user', 'id'], value: '4242' }] });
    expect(sql).toContain('(res_json @> $3::jsonb OR res_json @> $4::jsonb)');
    expect(values.slice(2, 4)).toEqual(['{"user":{"id":"4242"}}', '{"user":{"id":4242}}']);
  });

  it('json: a non-numeric value needs one probe only', () => {
    const { sql, values } = build({ clauses: [{ kind: 'json', path: ['status'], value: 'shipped' }] });
    expect(sql).toContain('res_json @> $3::jsonb');
    expect(sql).not.toContain('OR res_json');
    expect(values[2]).toBe('{"status":"shipped"}');
  });

  it('json: keys that look like operators stay data inside the JSON parameter', () => {
    expect(build({ clauses: [{ kind: 'json', path: ['__proto__'], value: 'x' }] }).values[2]).toBe('{"__proto__":"x"}');
  });

  it('a negated clause keeps rows where the column is NULL', () => {
    const { sql } = build({ clauses: [{ kind: 'json', neg: true, path: ['a'], value: 'b' }] });
    expect(sql).toContain('NOT COALESCE((res_json @> $3::jsonb), false)');
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
    expect(sql).toContain('(ts, id) < ($3, $4::bigint)');
    expect(values[2]).toEqual(new Date('2026-09-29T10:06:17.159Z'));
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
