// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import enAnalytics from '@/messages/en/analytics.json';
import frAnalytics from '@/messages/fr/analytics.json';
import arAnalytics from '@/messages/ar/analytics.json';
import { fail, mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import type { SearchToken } from '@/hooks/use-search-query';
import { queryKeys } from '@/lib/query-keys';
import { SEARCH_FIELDS, parseToken } from '@/lib/traffic-search';
import { SearchBar } from './search-bar';

const MESSAGES = { en: enAnalytics, fr: frAnalytics, ar: arAnalytics };
const T = enAnalytics.search;

const token = (text: string): SearchToken => ({ text, parsed: parseToken(text) });

const API_ROWS = [
  { apiDefId: 'api-1', name: 'Payments API', slug: 'payments', status: 'PUBLISHED', requests: 90, errors: 1, errorRate: 1, avgLatencyMs: 40 },
  { apiDefId: 'api-2', name: 'Orders', slug: 'orders-api', status: 'PUBLISHED', requests: 10, errors: 0, errorRate: 0, avgLatencyMs: 20 },
];
const KEY_ROWS = [
  { apiKeyId: 'k1', name: 'wp3 key', status: 'ACTIVE', apiDefName: 'Payments API', requests: 5, errors: 0, errorRate: 0, avgLatencyMs: 10 },
  { apiKeyId: 'k2', name: 'qbus-web', status: 'ACTIVE', apiDefName: null, requests: 4, errors: 0, errorRate: 0, avgLatencyMs: 10 },
];
const endpoint = (method: string, path: string) => ({ method, path, requests: 3, errors: 0, errorRate: 0, avgLatencyMs: 9, p95LatencyMs: 12 });
const API_LIST_PATH = '/analytics/apis?range=24h&limit=100';
const KEY_LIST_PATH = '/analytics/keys?range=24h&limit=100';
const isTraffic = (call: { path: string }) => call.path.startsWith('/analytics/traffic');
const trafficFor = (paths: [string, string][]) => ({ topEndpoints: paths.map(([method, path]) => endpoint(method, path)) });

function renderBar({ tokens = [], locale = 'en' }: { tokens?: SearchToken[]; locale?: 'en' | 'fr' | 'ar' } = {}) {
  const onAdd = vi.fn();
  // The app's own default is one retry: the suggestion queries must opt out of it themselves.
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={{ analytics: MESSAGES[locale] }}>
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <SearchBar tokens={tokens} tooMany={null} range="24h" onAdd={onAdd} onRemove={vi.fn()} onPreset={vi.fn()} />
        </div>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  const input = screen.getByRole<HTMLInputElement>('combobox');
  const type = (value: string) => {
    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value } });
  };
  const rowNames = () => screen.queryAllByRole('option').map((row) => row.textContent);
  return { onAdd, client, input, type, rowNames };
}

describe('SearchBar suggestions', () => {
  it('offers every field on focus, with what it filters on, without asking the server for anything', () => {
    const calls = mockFetch(() => fail(500, 'not expected'));
    const { input, type, rowNames } = renderBar();
    act(() => {
      input.focus();
    });
    expect(rowNames()).toHaveLength(SEARCH_FIELDS.length);
    expect(rowNames()[0]).toBe(`status:${T.suggest.fields.status}`);

    type('status:5');
    expect(rowNames()[0]).toBe(`5xx${T.suggest.status['5xx']}`);
    type('latency:');
    expect(rowNames()).toHaveLength(4);
    type('method:GET,P');
    expect(rowNames()).toEqual(['POST', 'PUT', 'PATCH', 'OPTIONS']);
    type('reqh:con');
    expect(rowNames()[0]).toBe('content-type');
    // Static fields and values need no data: nothing was fetched.
    expect(calls).toEqual([]);
  });

  it('completes a field into its values, then commits the chosen value as a filter', () => {
    mockFetch(() => fail(500, 'not expected'));
    const { onAdd, input, type, rowNames } = renderBar();
    type('sta');
    fireEvent.click(screen.getByRole('option', { name: /^status:/ }));
    expect(input.value).toBe('status:');
    expect(rowNames()).toContain(`404${T.suggest.status['404']}`);

    fireEvent.click(screen.getByRole('option', { name: /^>=500/ }));
    expect(onAdd).toHaveBeenCalledWith('status:>=500');
    expect(input.value).toBe('');
  });

  it('still submits the typed text on Enter when no row was highlighted', () => {
    mockFetch(() => fail(500, 'not expected'));
    const { onAdd, input, type } = renderBar();
    type('status:5');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('status:5');
  });

  it('offers API slugs from the list for `api:`, loaded only once an api filter is being typed', async () => {
    const calls = mockFetch((call) => (call.path.startsWith('/analytics/apis') ? ok(API_ROWS) : fail(500, 'not expected')));
    const { onAdd, input, type } = renderBar();
    act(() => {
      input.focus();
    });
    type('status:');
    expect(calls).toEqual([]);

    type('api:pa');
    fireEvent.click(await screen.findByRole('option', { name: /^payments/ }));
    expect(onAdd).toHaveBeenCalledWith('api:payments');
    expect(calls.map((call) => call.path)).toEqual([API_LIST_PATH]);
  });

  it('offers key names from the list, quoting one with a space', async () => {
    const calls = mockFetch((call) => (call.path.startsWith('/analytics/keys') ? ok(KEY_ROWS) : fail(500, 'not expected')));
    const { onAdd, type } = renderBar();
    type('key:');
    fireEvent.click(await screen.findByRole('option', { name: /wp3 key/ }));
    expect(onAdd).toHaveBeenCalledWith('key:"wp3 key"');
    expect(calls.map((call) => call.path)).toEqual([KEY_LIST_PATH]);
  });

  it('offers each top path once, whatever the methods', async () => {
    const calls = mockFetch((call) =>
      call.path.startsWith('/analytics/traffic')
        ? ok(trafficFor([['GET', '/orders'], ['POST', '/orders'], ['GET', '/health']]))
        : fail(500, 'not expected'),
    );
    const { rowNames, type } = renderBar();
    type('path:');
    await waitFor(() => {
      expect(rowNames()).toEqual(['/orders', '/health']);
    });
    expect(calls.map((call) => call.path)).toEqual(['/analytics/traffic?range=24h']);
  });

  it('scopes the paths to the API already filtered on, found the way the server finds it (any case)', async () => {
    const calls = mockFetch((call) => {
      if (call.path.startsWith('/analytics/apis')) return ok(API_ROWS);
      if (call.path === '/analytics/traffic?range=24h&apiId=api-1') return ok(trafficFor([['GET', '/charges']]));
      return fail(500, `not expected: ${call.path}`);
    });
    const { rowNames, type } = renderBar({ tokens: [token('api:PAYMENTS'), token('method:GET')] });
    type('path:');
    await waitFor(() => {
      expect(rowNames()).toEqual(['/charges']);
    });
    expect(calls.map((call) => call.path).sort()).toEqual([API_LIST_PATH, '/analytics/traffic?range=24h&apiId=api-1']);
  });

  it('offers no paths for an api filter that matches no API: that search finds nothing, so there is nothing to suggest', async () => {
    const calls = mockFetch((call) => (call.path.startsWith('/analytics/apis') ? ok(API_ROWS) : fail(500, `not expected: ${call.path}`)));
    const { client, type, rowNames } = renderBar({ tokens: [token('api:nope')] });
    // Every path of every API is already cached (say the traffic page asked): it is not this API's.
    client.setQueryData(queryKeys.analytics.traffic({ range: '24h' }), trafficFor([['GET', '/seeded']]));
    type('path:');
    await waitFor(() => {
      expect(calls.map((call) => call.path)).toEqual([API_LIST_PATH]);
    });
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
    });
    expect(rowNames()).toEqual([]);
    expect(calls.some(isTraffic)).toBe(false);
  });

  it('offers the same paths for route:, the exact-path filter', async () => {
    const calls = mockFetch((call) => (isTraffic(call) ? ok(trafficFor([['GET', '/'], ['GET', '/orders']])) : fail(500, `not expected: ${call.path}`)));
    const { onAdd, type } = renderBar();
    type('route:');
    fireEvent.click(await screen.findByRole('option', { name: /^\/orders/ }));
    expect(onAdd).toHaveBeenCalledWith('route:/orders');
    expect(calls.map((call) => call.path)).toEqual(['/analytics/traffic?range=24h']);
  });

  it('offers the paths of every API when the list of APIs cannot be loaded, since the filter cannot be resolved but the paths are still real', async () => {
    const calls = mockFetch((call) => {
      if (call.path.startsWith('/analytics/apis')) return fail(403, 'Forbidden', 'FORBIDDEN');
      if (call.path === '/analytics/traffic?range=24h') return ok(trafficFor([['GET', '/everything']]));
      return fail(500, `not expected: ${call.path}`);
    });
    const { rowNames, type } = renderBar({ tokens: [token('api:payments')] });
    type('path:');
    await waitFor(() => {
      expect(rowNames()).toEqual(['/everything']);
    });
    expect(calls.map((call) => call.path).sort()).toEqual([API_LIST_PATH, '/analytics/traffic?range=24h']);
  });

  it('does not narrow the paths by an api filter that excludes', async () => {
    const calls = mockFetch((call) => (isTraffic(call) ? ok(trafficFor([['GET', '/everything']])) : fail(500, `not expected: ${call.path}`)));
    const { rowNames, type } = renderBar({ tokens: [token('-api:payments')] });
    type('path:');
    await waitFor(() => {
      expect(rowNames()).toEqual(['/everything']);
    });
    expect(calls.map((call) => call.path)).toEqual(['/analytics/traffic?range=24h']);
  });

  it('offers the paths of every API when the typed name matches several, rather than those of the first', async () => {
    const twins = [
      { ...API_ROWS[1], apiDefId: 'twin-1', slug: 'orders-v1' },
      { ...API_ROWS[1], apiDefId: 'twin-2', slug: 'orders-v2' },
    ];
    const calls = mockFetch((call) => {
      if (call.path.startsWith('/analytics/apis')) return ok(twins);
      if (call.path === '/analytics/traffic?range=24h') return ok(trafficFor([['GET', '/from-both']]));
      return fail(500, `not expected: ${call.path}`);
    });
    const { rowNames, type } = renderBar({ tokens: [token('api:Orders')] });
    type('path:');
    await waitFor(() => {
      expect(rowNames()).toEqual(['/from-both']);
    });
    expect(calls.some((call) => call.path.includes('apiId'))).toBe(false);
  });

  it('offers the paths of every API when the one named is not in a list that was cut off at its limit', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...API_ROWS[0], apiDefId: `api-${String(i)}`, slug: `api-${String(i)}`, name: `API ${String(i)}` }));
    mockFetch((call) => {
      if (call.path.startsWith('/analytics/apis')) return ok(full);
      if (call.path === '/analytics/traffic?range=24h') return ok(trafficFor([['GET', '/maybe']]));
      return fail(500, `not expected: ${call.path}`);
    });
    const { rowNames, type } = renderBar({ tokens: [token('api:beyond-the-list')] });
    type('path:');
    await waitFor(() => {
      expect(rowNames()).toEqual(['/maybe']);
    });
  });

  it('degrades silently when a list cannot be loaded: no rows, no error shown, static suggestions unaffected', async () => {
    const calls = mockFetch(() => fail(403, 'Forbidden', 'FORBIDDEN'));
    const { client, type, rowNames } = renderBar();
    type('api:');
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
    });
    // Once, not retried: the page's own default would ask twice.
    expect(calls).toHaveLength(1);
    expect(rowNames()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/forbidden/i)).toBeNull();

    type('status:4');
    expect(rowNames()[0]).toBe(`4xx${T.suggest.status['4xx']}`);
    type('');
    expect(rowNames()).toHaveLength(SEARCH_FIELDS.length);
  });

  it('keeps the one-line hint until a body search is typed, then asks for a real word, and warns about a common one', () => {
    mockFetch(() => fail(500, 'not expected'));
    const { type } = renderBar();
    expect(screen.getByText(T.syntaxHint)).toBeDefined();

    type('body:');
    expect(screen.queryByRole('listbox')).toBeNull();
    const example = screen.getByText('body:"two words"', { selector: 'code' });
    expect(example.parentElement?.textContent).toBe(T.suggest.termHint.replace('{min}', '3').replace(/<\/?code>/g, ''));
    expect(screen.queryByText(T.syntaxHint)).toBeNull();

    type('res:data');
    expect(screen.getByText(T.errors.commonWord.replace('{term}', 'data'))).toBeDefined();
    type('body:"data');
    expect(screen.getByText(T.errors.commonWord.replace('{term}', 'data'))).toBeDefined();

    type('status:5');
    expect(screen.getByText(T.syntaxHint)).toBeDefined();
  });

  it.each(['en', 'fr', 'ar'] as const)('%s: the body-search example is its own left-to-right run inside the sentence', (locale) => {
    mockFetch(() => fail(500, 'not expected'));
    const { type } = renderBar({ locale });
    type('body:');
    const example = /<code>(.*)<\/code>/.exec(MESSAGES[locale].search.suggest.termHint)?.[1] ?? '';
    expect(example).toMatch(/^body:"/);
    const code = screen.getByText(example, { selector: 'code' });
    expect(code.getAttribute('dir')).toBe('ltr');
    // Nothing else of the sentence is inside it, and no stray bidi mark is left outside it.
    expect(code.parentElement?.textContent).not.toMatch(/\u200f/);
  });

  it('names the list and announces the count once typing pauses', async () => {
    mockFetch(() => fail(500, 'not expected'));
    const { input } = renderBar();
    act(() => {
      input.focus();
    });
    expect(screen.getByRole('listbox', { name: T.suggest.listLabel })).toBeDefined();
    expect(await screen.findByText(`${String(SEARCH_FIELDS.length)} suggestions available`)).toBeDefined();
  });

  it.each([
    ['en', 'No suggestions available'],
    ['fr', 'Aucune suggestion disponible'],
    ['ar', 'لا توجد اقتراحات'],
  ] as const)('%s says so when nothing can be suggested', async (locale, none) => {
    mockFetch(() => fail(500, 'not expected'));
    const { type } = renderBar({ locale });
    type('zzz');
    expect(await screen.findByText(none)).toBeDefined();
  });

  it.each(['fr', 'ar'] as const)('speaks %s: translated descriptions and announcement, the tokens still left-to-right', async (locale) => {
    mockFetch(() => fail(500, 'not expected'));
    const messages = MESSAGES[locale].search;
    const { input, rowNames } = renderBar({ locale });
    act(() => {
      input.focus();
    });
    expect(screen.getByRole('listbox', { name: messages.suggest.listLabel })).toBeDefined();
    expect(rowNames()[0]).toBe(`status:${messages.suggest.fields.status}`);
    expect(input.dir).toBe('ltr');
    await waitFor(() => {
      const announcement = screen.getAllByRole('status').find((node) => node.className.includes('sr-only'));
      expect(announcement?.textContent).toBeTruthy();
      expect(announcement?.textContent).not.toContain('suggest.count');
    });
    // The row's token is its own left-to-right run inside a right-to-left list.
    expect(screen.getAllByRole('option')[0]?.querySelector('[dir="ltr"]')?.textContent).toBe('status:');
  });
});
