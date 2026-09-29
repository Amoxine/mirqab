import 'reflect-metadata';
import { analyticsWindow, UNAUTHENTICATED_KEY_HASH } from './pump-query.builder';
import {
  escapeLike,
  trafficEndpointQuery,
  trafficSummaryQuery,
  trafficWhere,
} from './traffic-query.builder';

const window24 = analyticsWindow('24h', new Date('2026-09-19T14:37:30.000Z'));
const flat = (sql: { text: string }) => sql.text.replace(/\s+/g, ' ').trim();

describe('trafficWhere', () => {
  it('always scopes to the tenant api ids and the window, and binds them', () => {
    const sql = trafficWhere(window24, { tykApiIds: ['a', 'b'] });
    expect(flat(sql)).toBe('apiid = ANY($1::text[]) AND "timestamp" >= $2');
    expect(sql.values).toEqual([['a', 'b'], window24.from]);
  });

  it('adds one bound predicate per filter, never interpolating a value', () => {
    const sql = trafficWhere(window24, {
      tykApiIds: ['a'],
      keyHash: 'k1',
      method: 'POST',
      status: 429,
      minLatencyMs: 500,
    });
    const text = flat(sql);
    expect(text).toContain('apikey = $3');
    expect(text).toContain('method = $4');
    expect(text).toContain('responsecode = $5');
    expect(text).toContain('latency_total >= $6');
    expect(text).not.toContain('POST');
    expect(text).not.toContain('429');
  });

  it('turns a status class into a half-open code range', () => {
    const sql = trafficWhere(window24, { tykApiIds: ['a'], statusClass: '5xx' });
    expect(sql.values.slice(-2)).toEqual([500, 600]);
  });

  it('matches the path literally: LIKE wildcards typed by the user are escaped', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
    const sql = trafficWhere(window24, { tykApiIds: ['a'], path: '100%_done' });
    expect(flat(sql)).toContain("path ILIKE $3 ESCAPE '\\'");
    expect(sql.values[2]).toBe('%100\\%\\_done%');
  });

  it('splits authenticated from anonymous by the unauthenticated key hash', () => {
    expect(trafficWhere(window24, { tykApiIds: ['a'], auth: 'anonymous' }).values).toContain(
      UNAUTHENTICATED_KEY_HASH,
    );
    expect(flat(trafficWhere(window24, { tykApiIds: ['a'], auth: 'authenticated' }))).toContain(
      'apikey <> $3',
    );
  });
});

describe('traffic queries', () => {
  it('always read the raw table and reuse the same WHERE', () => {
    for (const sql of [
      trafficSummaryQuery(window24, { tykApiIds: ['a'] }),
      trafficEndpointQuery(window24, { tykApiIds: ['a'] }),
    ]) {
      expect(flat(sql)).toContain('FROM public.tyk_analytics');
      expect(flat(sql)).toContain('apiid = ANY(');
    }
  });

  it('bounds the endpoint rollup', () => {
    expect(flat(trafficEndpointQuery(window24, { tykApiIds: ['a'] }))).toMatch(/LIMIT \$\d+$/);
  });
});
