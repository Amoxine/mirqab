import { describe, expect, it } from 'vitest';
import { parseTrafficFilters } from '@/hooks/use-traffic-filters';
import { parseToken, SEARCH_LIMITS } from '@/lib/traffic-search';
import type { TrafficFilters } from '@/types';
import {
  endpointTokens,
  searchHref,
  searchToken,
  statusCodeTokens,
  trafficFiltersToSearchHref,
  trafficFiltersToSearchQuery,
  trafficHref,
} from './traffic-filters-to-query';

const base: TrafficFilters = { range: '24h' };
const KEY_ID = '5f1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c11';
const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const names: Record<string, string> = { [KEY_ID]: 'qbus-web', other: 'my key', quoted: 'say "hi"' };
const ctx = { keyName: (id: string) => names[id] };

describe('trafficFiltersToSearchQuery', () => {
  it.each<[string, Partial<TrafficFilters>, string]>([
    ['no filters', {}, ''],
    ['a method', { method: 'POST' }, 'method:POST'],
    ['a status class', { statusClass: '5xx' }, 'status:5xx'],
    ['a redirect class', { statusClass: '3xx' }, 'status:3xx'],
    ['an exact status', { status: 429 }, 'status:429'],
    ['a rooted path', { path: '/v1/orders' }, 'path:/v1/orders'],
    ['a slower-than latency', { minLatencyMs: 500 }, 'latency:>=500'],
    ['an API id (the server matches id, name or slug)', { apiId: API_ID }, `api:${API_ID}`],
    ['a key, by its name', { keyId: KEY_ID }, 'key:qbus-web'],
    ['a key whose name has a space, quoted', { keyId: 'other' }, 'key:"my key"'],
    [
      'everything at once, in a stable order',
      {
        apiId: API_ID,
        keyId: KEY_ID,
        method: 'GET',
        statusClass: '4xx',
        status: 404,
        path: '/v1/orders',
        minLatencyMs: 250,
      },
      `api:${API_ID} key:qbus-web method:GET status:4xx status:404 path:/v1/orders latency:>=250`,
    ],
  ])('%s', (_name, patch, expected) => {
    expect(trafficFiltersToSearchQuery({ ...base, ...patch }, ctx)).toBe(expected);
  });

  it('quotes a path with a space with quoteValue', () => {
    expect(trafficFiltersToSearchQuery({ ...base, path: '/my orders' }, ctx)).toBe('path:"/my orders"');
  });

  describe('what search cannot say is left out, never guessed', () => {
    it.each<[string, Partial<TrafficFilters>]>([
      ['a key the lookup does not know', { keyId: 'unknown-id' }],
      ['a key name with a double quote (no escape exists)', { keyId: 'quoted' }],
      ['a path with a double quote', { path: '/a"b/orders' }],
      ['a path shorter than 3 letters or digits', { path: '/a' }],
      ['a path that is only slashes and dots', { path: '/./' }],
      // The traffic filter is a substring match; search `path:` is a PREFIX of a path that always starts with "/".
      ['a path fragment that is not rooted (a prefix of it would match nothing)', { path: 'orders' }],
      ['the authentication filter, which has no search clause', { auth: 'anonymous' }],
      ['a latency of 0, which matches everything', { minLatencyMs: 0 }],
      ['a fractional latency, which the grammar refuses', { minLatencyMs: 250.5 }],
      ['a negative latency', { minLatencyMs: -1 }],
      // The API refuses these with a 400, so a link built from a hand-edited URL must not carry them.
      ['a status below 100', { status: 99 }],
      ['a status above 599', { status: 600 }],
      ['a status far out of range', { status: 700 }],
      ['a fractional status', { status: 404.5 }],
      ['a latency above the API maximum (600,000 ms)', { minLatencyMs: 600_001 }],
    ])('%s', (_name, patch) => {
      expect(trafficFiltersToSearchQuery({ ...base, ...patch }, ctx)).toBe('');
    });

    it.each([
      ['the lowest status', { status: 100 }, 'status:100'],
      ['the highest status', { status: 599 }, 'status:599'],
      ['the highest latency the API takes', { minLatencyMs: 600_000 }, 'latency:>=600000'],
      ['the lowest latency that filters anything', { minLatencyMs: 1 }, 'latency:>=1'],
    ])('keeps %s', (_name, patch, expected) => {
      expect(trafficFiltersToSearchQuery({ ...base, ...patch }, ctx)).toBe(expected);
    });

    it('keeps the representable filters when one cannot be written', () => {
      expect(
        trafficFiltersToSearchQuery({ ...base, keyId: 'unknown-id', method: 'PUT', auth: 'authenticated' }, ctx),
      ).toBe('method:PUT');
    });

    it('works without a key lookup at all', () => {
      expect(trafficFiltersToSearchQuery({ ...base, keyId: KEY_ID, method: 'GET' })).toBe('method:GET');
    });
  });

  it('only ever produces tokens the search bar accepts', () => {
    const query = trafficFiltersToSearchQuery(
      { ...base, apiId: API_ID, keyId: 'other', method: 'DELETE', statusClass: '5xx', path: '/my orders', minLatencyMs: 1000 },
      ctx,
    );
    // Whitespace inside quotes is part of one token; tokenize it the way the bar does.
    for (const token of query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) expect(parseToken(token).ok).toBe(true);
  });
});

describe('searchToken', () => {
  it('writes field:value, negated with a leading dash', () => {
    expect(searchToken('status', '>=400')).toBe('status:>=400');
    expect(searchToken('status', '404', true)).toBe('-status:404');
  });
  it('returns null for what quoteValue or the grammar refuses', () => {
    expect(searchToken('key', '')).toBeNull();
    expect(searchToken('key', 'a"b')).toBeNull();
    expect(searchToken('path', '/a')).toBeNull();
    expect(searchToken('status', '99')).toBeNull();
  });
});

describe('searchHref', () => {
  const parse = (href: string) => {
    const url = new URL(href, 'http://x');
    return { path: url.pathname, q: url.searchParams.get('q'), range: url.searchParams.get('range') };
  };

  it('puts the tokens in ?q and the range in ?range', () => {
    expect(parse(searchHref(['status:>=400', 'method:POST'], '7d'))).toEqual({
      path: '/analytics/search',
      q: 'status:>=400 method:POST',
      range: '7d',
    });
  });
  it('encodes the query, so the URL is one the search page reads back unchanged', () => {
    expect(searchHref(['status:>=400'], '24h')).toBe('/analytics/search?q=status%3A%3E%3D400');
  });
  it('drops the default range, as the search page itself does', () => {
    expect(parse(searchHref(['status:5xx'], '24h')).range).toBeNull();
  });
  it('skips tokens that could not be written', () => {
    expect(parse(searchHref([null, 'status:5xx', null], '1h')).q).toBe('status:5xx');
  });
  it('is the bare search page when there is nothing to search for', () => {
    expect(searchHref([], '24h')).toBe('/analytics/search');
    expect(searchHref([null], '30d')).toBe('/analytics/search?range=30d');
  });
});

describe('trafficFiltersToSearchHref', () => {
  const q = (href: string) => new URL(href, 'http://x').searchParams.get('q');

  it('carries the current filters and range', () => {
    const href = trafficFiltersToSearchHref({ range: '7d', method: 'POST', statusClass: '5xx' }, ctx);
    expect(q(href)).toBe('method:POST status:5xx');
    expect(new URL(href, 'http://x').searchParams.get('range')).toBe('7d');
  });
  it('appends the tile-specific tokens after the filters', () => {
    expect(q(trafficFiltersToSearchHref({ ...base, method: 'GET' }, ctx, ['status:>=400']))).toBe('method:GET status:>=400');
  });
  it('skips tile tokens that could not be written', () => {
    expect(q(trafficFiltersToSearchHref({ ...base, method: 'GET' }, ctx, [null, 'status:>=400', null]))).toBe(
      'method:GET status:>=400',
    );
  });
  it('never exceeds the search bar clause cap: the tile token wins over the last filters', () => {
    const href = trafficFiltersToSearchHref(
      {
        ...base,
        apiId: API_ID,
        keyId: KEY_ID,
        method: 'GET',
        statusClass: '4xx',
        status: 404,
        path: '/v1/orders',
        minLatencyMs: 250,
      },
      ctx,
      ['status:>=400', 'latency:>=900'],
    );
    const tokens = (q(href) ?? '').split(' ');
    expect(tokens).toHaveLength(SEARCH_LIMITS.maxClauses);
    expect(tokens.slice(-2)).toEqual(['status:>=400', 'latency:>=900']);
  });
});

describe('endpointTokens', () => {
  // An endpoint table groups by the exact (method, path), so the link is `route:` (the whole path), not
  // `path:` (a prefix, which would also list /v1/orders/42 and refuses a path under 3 letters).
  it('selects one endpoint: its exact path and its method', () => {
    expect(endpointTokens({ method: 'GET', path: '/v1/orders' })).toEqual(['route:/v1/orders', 'method:GET']);
  });
  it('names the API first when the view is narrowed to one', () => {
    expect(endpointTokens({ method: 'POST', path: '/v1/orders' }, API_ID)).toEqual([
      `api:${API_ID}`,
      'route:/v1/orders',
      'method:POST',
    ]);
  });
  it.each(['/', '/a', '/me'])('takes the short path %s, which a prefix filter would have dropped', (path) => {
    expect(endpointTokens({ method: 'GET', path })).toEqual([`route:${path}`, 'method:GET']);
  });
  it('quotes a path with a space', () => {
    expect(endpointTokens({ method: 'GET', path: '/my orders' })).toEqual(['route:"/my orders"', 'method:GET']);
  });
  it.each([['a double quote', '/a"b'], ['a line feed', '/a\nb'], ['a line separator', '/a b']])(
    'gives no tokens at all for a path with %s: no link, rather than one that lists more than the row counts',
    (_name, path) => {
      expect(endpointTokens({ method: 'GET', path })).toBeNull();
      expect(endpointTokens({ method: 'GET', path }, API_ID)).toBeNull();
    },
  );
  it('gives no tokens when the API cannot be written either', () => {
    expect(endpointTokens({ method: 'GET', path: '/v1/orders' }, 'a"b')).toBeNull();
  });
  it('only ever produces tokens the search bar accepts', () => {
    for (const token of endpointTokens({ method: 'DELETE', path: '/v1/orders/{id}' }, API_ID) ?? []) {
      expect(parseToken(token).ok, token).toBe(true);
    }
  });
});

describe('statusCodeTokens', () => {
  it.each([
    ['the success class', '2xx', ['status:2xx']],
    ['a code listed on its own', '401', ['status:401']],
    ['a server error listed on its own', '503', ['status:503']],
  ])('%s is just that status', (_name, code, expected) => {
    expect(statusCodeTokens(code)).toEqual(expected);
  });

  // The breakdown's "4xx" / "5xx" are REMAINDER buckets: every other code of the class, i.e. not the
  // ones the breakdown lists separately. `status:4xx` alone would also count those and overstate it.
  it('"4xx" is the other client errors: the class without the codes listed separately', () => {
    expect(statusCodeTokens('4xx')).toEqual(['status:4xx', '-status:400,401,403,404,429']);
  });
  it('"5xx" is the other server errors', () => {
    expect(statusCodeTokens('5xx')).toEqual(['status:5xx', '-status:500,502,503,504']);
  });
  it('only ever produces tokens the search bar accepts', () => {
    for (const code of ['2xx', '401', '4xx', '5xx']) {
      for (const token of statusCodeTokens(code)) expect(token === null ? true : parseToken(token).ok).toBe(true);
    }
  });
});

describe('trafficHref', () => {
  const parse = (href: string) => {
    const url = new URL(href, 'http://x');
    return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
  };

  it('is the bare traffic page for the default range and no filters', () => {
    expect(trafficHref({ range: '24h' })).toBe('/analytics/traffic');
  });
  it('names the filters exactly as the traffic page reads them', () => {
    expect(parse(trafficHref({ range: '7d', apiId: API_ID, keyId: KEY_ID, method: 'GET', path: '/v1/orders' }))).toEqual({
      path: '/analytics/traffic',
      params: { range: '7d', apiId: API_ID, keyId: KEY_ID, method: 'GET', path: '/v1/orders' },
    });
  });
  it('leaves out empty values', () => {
    expect(trafficHref({ range: '1h', apiId: undefined, path: '' })).toBe('/analytics/traffic?range=1h');
  });
});

// The traffic page reads its filters back with `parseTrafficFilters`, so a link is only as good as that
// round trip: a renamed parameter, or a value the encoder mangles, would open the page on the wrong filters.
describe('trafficHref round-trips through the traffic page’s own parser', () => {
  it.each<[string, TrafficFilters]>([
    ['the default range and nothing else', { range: '24h' }],
    ['a range', { range: '30d' }],
    ['an API and a key', { range: '1h', apiId: API_ID, keyId: KEY_ID }],
    ['a method and a status class', { range: '24h', method: 'DELETE', statusClass: '4xx' }],
    ['an exact status', { range: '24h', status: 503 }],
    ['a latency floor', { range: '7d', minLatencyMs: 1000 }],
    ['an authentication filter', { range: '24h', auth: 'anonymous' }],
    ['a path with spaces, ampersands, equals, percent and unicode', { range: '24h', path: '/v1/my orders?a=1&b=%20/é/ß' }],
    [
      'every filter at once',
      {
        range: '7d',
        apiId: API_ID,
        keyId: KEY_ID,
        method: 'POST',
        statusClass: '5xx',
        status: 503,
        path: '/v1/orders',
        minLatencyMs: 250,
        auth: 'authenticated',
      },
    ],
  ])('%s', (_name, filters) => {
    const url = new URL(trafficHref(filters), 'http://localhost');
    expect(url.pathname).toBe('/analytics/traffic');
    expect(parseTrafficFilters(url.searchParams)).toEqual(filters);
  });
});
