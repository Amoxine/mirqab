import { describe, expect, it } from 'vitest';
import { parseTrafficFilters } from './use-traffic-filters';

const activeFilterCount = (filters: object) =>
  Object.entries(filters).filter(([key, v]) => key !== 'range' && v !== undefined && v !== '').length;

describe('parseTrafficFilters', () => {
  it('defaults to the last 24 hours with no filters', () => {
    const filters = parseTrafficFilters(new URLSearchParams());
    expect(filters.range).toBe('24h');
    expect(activeFilterCount(filters)).toBe(0);
  });

  it('reads every filter from the query string', () => {
    const filters = parseTrafficFilters(
      new URLSearchParams(
        'range=7d&apiId=a1&keyId=k1&method=POST&statusClass=5xx&status=503&path=/v1&minLatencyMs=500&auth=anonymous',
      ),
    );
    expect(filters).toEqual({
      range: '7d',
      apiId: 'a1',
      keyId: 'k1',
      method: 'POST',
      statusClass: '5xx',
      status: 503,
      path: '/v1',
      minLatencyMs: 500,
      auth: 'anonymous',
    });
    // The range always applies, so it is not counted as a narrowing filter.
    expect(activeFilterCount(filters)).toBe(8);
  });

  it('drops values that are not known: a shared link cannot inject a bad range, class or number', () => {
    const filters = parseTrafficFilters(
      new URLSearchParams('range=1y&statusClass=9xx&auth=root&status=abc&minLatencyMs='),
    );
    expect(filters.range).toBe('24h');
    expect(filters.statusClass).toBeUndefined();
    expect(filters.auth).toBeUndefined();
    expect(filters.status).toBeUndefined();
    expect(filters.minLatencyMs).toBeUndefined();
  });
});
