import { BATCH_SIZE, capturedPageSql } from './traffic-search.page-query';

const FROM = new Date('2026-09-22T12:00:00.000Z');
const TO = new Date('2026-09-29T12:00:00.000Z');
const CURSOR = { ts: '2026-09-27T08:15:30.123456Z', key: 'abc123' };
const flat = (q: { text: string }): string => q.text.replace(/\s+/g, ' ').trim();

describe('capturedPageSql', () => {
  it('without a cursor reads the whole window on both sides', () => {
    const q = capturedPageSql(FROM, TO, null);
    expect(flat(q)).toContain('"timestamp" >= $1 AND "timestamp" < $2 OFFSET 0 ) captured');
    expect(flat(q)).toContain('WHERE s.ts >= $3 AND s.ts < $4 AND');
    expect(q.values).toEqual([FROM, TO, FROM, TO, BATCH_SIZE]);
    expect(flat(q)).not.toContain('dedupe_key) >');
  });

  it('with a cursor starts BOTH the pump rows and the projection side of the anti-join at the cursor, not at the window start', () => {
    const q = capturedPageSql(FROM, TO, CURSOR);
    const sql = flat(q);
    // Pump side: the window, then the cursor's instant as an explicit lower bound.
    expect(sql).toContain('AND "timestamp" >= $3::timestamptz OFFSET 0 ) captured');
    // Projection side: from the cursor, so rows indexed before it are never read.
    expect(sql).toMatch(/WHERE s\.ts >= \$4::timestamptz AND s\.ts < \$5 AND s\.ts = captured\."timestamp"/);
    expect(sql).toContain('("timestamp", dedupe_key) > ($6::timestamptz, $7)');
    expect(q.values).toEqual([FROM, TO, CURSOR.ts, CURSOR.ts, TO, CURSOR.ts, CURSOR.key, BATCH_SIZE]);
  });

  it('keeps the microseconds of the cursor as text', () => {
    expect(capturedPageSql(FROM, TO, CURSOR).values).toContain('2026-09-27T08:15:30.123456Z');
  });

  it('orders by the keyset and limits to one batch', () => {
    const sql = flat(capturedPageSql(FROM, TO, null));
    expect(sql).toContain('ORDER BY "timestamp", dedupe_key LIMIT $5');
  });

  it('hashes a JSON array of the identifying columns, so a separator in a value cannot make two rows one key', () => {
    const sql = flat(capturedPageSql(FROM, TO, null));
    expect(sql).toContain('jsonb_build_array(apiid');
    expect(sql).not.toContain("concat_ws('|'");
  });

  it('computes the dedupe key once per captured row: the inner query ends in OFFSET 0, so the key is a column of the join, not an expression in it', () => {
    const sql = flat(capturedPageSql(FROM, TO, CURSOR));
    expect(sql).toMatch(/OFFSET 0 \) captured WHERE NOT EXISTS/);
    expect(sql.indexOf('sha256(')).toBeLessThan(sql.indexOf('OFFSET 0'));
    expect(sql.slice(sql.indexOf('OFFSET 0'))).not.toContain('sha256(');
  });

  it('filters on exactly the predicate the partial indexes carry, so the planner can use them', () => {
    expect(flat(capturedPageSql(FROM, TO, null))).toContain("WHERE (rawrequest <> '' OR rawresponse <> '')");
  });
});
