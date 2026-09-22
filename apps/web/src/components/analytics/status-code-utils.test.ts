import { describe, expect, it } from 'vitest';
import { toStatusRows } from './status-code-utils';

describe('toStatusRows', () => {
  it('puts every count on the stack key its status class owns', () => {
    expect(
      toStatusRows([
        { code: '2xx', count: 37 },
        { code: '404', count: 11 },
        { code: '503', count: 2 },
      ]),
    ).toEqual([
      { code: '2xx', ok: 37, client: 0, server: 0 },
      { code: '404', ok: 0, client: 11, server: 0 },
      { code: '503', ok: 0, client: 0, server: 2 },
    ]);
  });

  // The regression this guards: rows missing a stack key made recharts compute NaN geometry,
  // so the chart rendered axes and a legend but no bars at all.
  it('always emits all three stack keys as numbers', () => {
    for (const row of toStatusRows([{ code: '429', count: 5 }, { code: '2xx', count: 1 }])) {
      for (const key of ['ok', 'client', 'server'] as const) {
        expect(typeof row[key]).toBe('number');
        expect(Number.isNaN(row[key])).toBe(false);
      }
    }
  });

  it('returns nothing for no data', () => {
    expect(toStatusRows([])).toEqual([]);
  });
});
