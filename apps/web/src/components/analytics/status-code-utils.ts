/** Pure helpers for the status-code chart, kept import-free so vitest can load them directly. */

type StatusClass = 'ok' | 'client' | 'server';

export interface StatusCodeRow {
  code: string;
  ok: number;
  client: number;
  server: number;
}

/** `code` is `'2xx'`, a specific error code (`'401'`) or a bucket (`'5xx'`); the first digit decides the colour. */
function statusClass(code: string): StatusClass {
  if (code.startsWith('5')) return 'server';
  if (code.startsWith('4')) return 'client';
  return 'ok';
}

/**
 * One row per status code, carrying ALL three stack keys.
 * The zeros are load-bearing: recharts sums a stack across its dataKeys, so a row missing one of
 * them yields NaN bar geometry and the chart renders as empty axes with a legend and no bars.
 */
export function toStatusRows(data: { code: string; count: number }[]): StatusCodeRow[] {
  return data.map((item) => ({
    code: item.code,
    ok: 0,
    client: 0,
    server: 0,
    [statusClass(item.code)]: item.count,
  }));
}
