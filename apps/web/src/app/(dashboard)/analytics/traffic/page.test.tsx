// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp, withRowClock } from '@/components/dashboard/test-render';
import TrafficPage from './page';

const replace = vi.fn();
let search = '';
let granted: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/analytics/traffic',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const KEY_ID = '5f1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c11';
const health = {
  pipelineReady: true,
  pumpReachable: true,
  rawTablePresent: true,
  aggregateTablePresent: true,
  lastRecordAt: '2026-09-29T10:00:00.000Z',
  rowCount: 10,
};
const endpoint = (method: string, path: string) => ({
  method,
  path,
  requests: 700,
  errors: 21,
  errorRate: 3,
  avgLatencyMs: 90,
  p95LatencyMs: 200,
});
const baseTraffic = {
  range: '24h',
  windowSeconds: 86_400,
  summary: {
    requests: 5_000,
    requestsPerSecond: 0.06,
    errors: 50,
    errorRate: 1,
    clientErrors: 30,
    serverErrors: 20,
    avgLatencyMs: 110,
    avgUpstreamLatencyMs: 90,
    p50LatencyMs: 80,
    p95LatencyMs: 312.4,
    p99LatencyMs: 700,
    uniqueClients: 9,
    uniqueKeys: 3,
    anonymousShare: 0,
    bytesIn: 1_000,
    lastRequestAt: '2026-09-29T10:00:00.000Z',
  },
  timeseries: [],
  statusClasses: [
    { class: '2xx', count: 4_950 },
    { class: '3xx', count: 0 },
    { class: '4xx', count: 30 },
    { class: '5xx', count: 20 },
  ],
  statusCodes: [
    { code: 200, count: 4_950 },
    { code: 429, count: 30 },
  ],
  methods: [
    { method: 'GET', count: 4_000 },
    { method: 'POST', count: 1_000 },
  ],
  topEndpoints: [endpoint('GET', '/v1/orders'), endpoint('POST', '/v1/orders')],
  slowestEndpoints: [endpoint('GET', '/v1/slow')],
};
let traffic: typeof baseTraffic = baseTraffic;
/** The key rows `/analytics/keys` answers; the traffic page names a filtered key from these. */
let analyticsKeys: unknown[] = [];
/** The key list `/keys` answers (the filter bar's choices); the page does not name keys from it. */
let keyList: unknown[] = [];
/** While set, `/analytics/traffic` waits for it: a changed filter is then still loading. */
let hold: Promise<void> | null = null;
let calls: { path: string }[] = [];
const page = (data: unknown[]) => ok({ data, meta: { page: 1, pageSize: 100, totalCount: data.length, totalPages: 1 } });
const WAIT = { timeout: 8000 };
const T = analytics.traffic;
const target = (el: HTMLElement) => new URL(el.getAttribute('href') ?? '', 'http://x');
const q = (el: HTMLElement) => target(el).searchParams.get('q');

beforeEach(() => {
  replace.mockClear();
  search = '';
  traffic = baseTraffic;
  hold = null;
  keyList = [{ id: KEY_ID, name: 'qbus-web', status: 'ACTIVE', apiDefId: API_ID, apiDefName: 'Orders API' }];
  analyticsKeys = [
    { apiKeyId: KEY_ID, name: 'qbus-web', status: 'ACTIVE', apiDefName: 'Orders API', requests: 1, errors: 0, errorRate: 0, avgLatencyMs: 1 },
  ];
  granted = ['analytics:read', 'api:update', 'key:read', 'api:read'];
  calls = mockFetch((call) => {
    if (call.path.startsWith('/analytics/health')) return ok(health);
    if (call.path.startsWith('/analytics/keys')) return ok(analyticsKeys);
    if (call.path.startsWith('/analytics/traffic')) return hold ? hold.then(() => ok(traffic)) : ok(traffic);
    if (call.path.startsWith('/keys')) return page(keyList);
    if (call.path.startsWith('/apis')) return page([{ id: API_ID, name: 'Orders API' }]);
    return ok([]);
  });
});

describe('traffic page click-through: the figures', () => {
  it('opens request search with the current filters from the request count', async () => {
    search = 'method=POST&statusClass=5xx&range=7d';
    renderApp(<TrafficPage />);
    const link = await screen.findByRole('link', { name: T.kpis.requests }, WAIT);
    expect(q(link)).toBe('method:POST status:5xx');
    expect(target(link).searchParams.get('range')).toBe('7d');
  });

  it('adds the failed requests (status 400 and up, how errors are counted) to the error-rate figure', async () => {
    search = 'method=POST';
    renderApp(<TrafficPage />);
    const link = await screen.findByRole('link', { name: T.kpis.errorRate }, WAIT);
    expect(q(link)).toBe('method:POST status:>=400');
  });

  it('adds a latency floor at the percentile to the slow-tail figures', async () => {
    renderApp(<TrafficPage />);
    const p95 = await screen.findByRole('link', { name: T.kpis.p95 }, WAIT);
    expect(q(p95)).toBe('latency:>=312');
    expect(q(screen.getByRole('link', { name: T.kpis.p99 }))).toBe('latency:>=700');
  });

  it('carries the page filters on the throughput, latency, clients and data tiles too', async () => {
    search = 'method=POST';
    renderApp(<TrafficPage />);
    await screen.findByRole('link', { name: T.kpis.requests }, WAIT);
    for (const name of [T.kpis.throughput, T.kpis.avgLatency, T.kpis.clients, T.kpis.dataIn]) {
      const link = screen.getByRole('link', { name });
      expect(target(link).pathname, name).toBe('/analytics/search');
      expect(q(link), name).toBe('method:POST');
    }
  });

  it('names a filtered key from the analytics keys, so it needs neither key:read nor the first page of the key list', async () => {
    // The key list answers nothing here; only /analytics/keys knows the key.
    keyList = [];
    granted = ['analytics:read', 'api:update'];
    search = `keyId=${KEY_ID}&method=GET`;
    renderApp(<TrafficPage />);
    await screen.findByRole('link', { name: T.kpis.requests }, WAIT);
    await waitFor(() => {
      expect(q(screen.getByRole('link', { name: T.kpis.requests }))).toBe('key:qbus-web method:GET');
    }, WAIT);
  });

  it('asks only for what analytics:read allows: the filter lists come from the analytics endpoints, not the API and key lists', async () => {
    granted = ['analytics:read'];
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    await waitFor(() => {
      expect(calls.some((c) => c.path.startsWith('/analytics/apis'))).toBe(true);
      expect(calls.some((c) => c.path.startsWith('/analytics/keys'))).toBe(true);
    }, WAIT);
    // One turn of the event loop inside `act`: whatever the page was going to ask for on mount has been asked.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls.filter((c) => !c.path.startsWith('/analytics/'))).toEqual([]);
  });

  it('asks for the analytics keys once, for the filter list, when search is closed to the user (the hook that names keys for links stays off: see use-traffic-search-href.test.tsx)', async () => {
    granted = ['analytics:read'];
    search = `keyId=${KEY_ID}`;
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    await waitFor(() => {
      expect(calls.filter((c) => c.path.startsWith('/analytics/keys'))).toHaveLength(1);
    }, WAIT);
  });

  it('names a filtered key by its name, looked up from the key list', async () => {
    search = `apiId=${API_ID}&keyId=${KEY_ID}`;
    renderApp(<TrafficPage />);
    const link = await screen.findByRole('link', { name: T.kpis.requests }, WAIT);
    // The key list is a second request: the figure is first built without it, then with.
    await vi.waitFor(() => {
      expect(q(screen.getByRole('link', { name: T.kpis.requests }))).toBe(`api:${API_ID} key:qbus-web`);
    }, WAIT);
    expect(link).toBeDefined();
  });

  it('leaves a key out of the search when another key has the same name, since `key:` would list both', async () => {
    const SOLO = '11111111-1111-4111-8111-111111111111';
    const TWIN = '22222222-2222-4222-8222-222222222222';
    const row = (apiKeyId: string, name: string) => ({ apiKeyId, name, status: 'ACTIVE', apiDefName: 'Orders API', requests: 1, errors: 0, errorRate: 0, avgLatencyMs: 1 });
    analyticsKeys = [row(KEY_ID, 'qbus-web'), row(TWIN, 'qbus-web'), row(SOLO, 'solo')];
    search = `keyId=${SOLO}`;
    const view = renderApp(<TrafficPage />);
    // The keys have loaded once the unique one is named: that is the control for what follows.
    await waitFor(() => {
      expect(q(screen.getByRole('link', { name: T.kpis.requests }))).toBe('key:solo');
    }, WAIT);
    search = `keyId=${KEY_ID}`;
    view.rerender(<TrafficPage />);
    expect(screen.getByRole('link', { name: T.kpis.requests }).getAttribute('href')).not.toContain('key');
  });

  it('leaves a key it cannot name out of the search rather than guessing', async () => {
    search = `keyId=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}&method=GET`;
    renderApp(<TrafficPage />);
    const link = await screen.findByRole('link', { name: T.kpis.requests }, WAIT);
    expect(q(link)).toBe('method:GET');
  });

  it('has no search links for someone who cannot open search', async () => {
    granted = ['analytics:read'];
    renderApp(<TrafficPage />);
    // "Requests" is also a column header, so wait on the tile's own text via the endpoint rows loading.
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    expect(screen.getAllByText(T.kpis.requests).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: T.kpis.requests })).toBeNull();
    expect(screen.queryByRole('link', { name: T.filters.viewRequests })).toBeNull();
    expect(document.querySelector('a[data-row-link]')).toBeNull();
  });
});

describe('traffic page click-through: the "view these requests" button', () => {
  it('is a link to the same search the figures open, with the translated filters', async () => {
    search = 'method=POST&statusClass=5xx&minLatencyMs=500&range=30d';
    renderApp(<TrafficPage />);
    const button = await screen.findByRole('link', { name: T.filters.viewRequests }, WAIT);
    expect(q(button)).toBe('method:POST status:5xx latency:>=500');
    expect(target(button).searchParams.get('range')).toBe('30d');
  });
});

describe('traffic page click-through: the mix', () => {
  it('filters in place to a status class, and clears it when clicked again', async () => {
    renderApp(<TrafficPage />);
    const server = await screen.findByRole('button', { name: /Server error \(5xx\)/ }, WAIT);
    expect(server.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(server);
    expect(replace).toHaveBeenLastCalledWith('/analytics/traffic?statusClass=5xx', { scroll: false });
  });

  it('shows the active class as pressed and a second click removes it', async () => {
    search = 'statusClass=5xx';
    renderApp(<TrafficPage />);
    const server = await screen.findByRole('button', { name: /Server error \(5xx\)/ }, WAIT);
    expect(server.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(server);
    expect(replace).toHaveBeenLastCalledWith('/analytics/traffic', { scroll: false });
  });

  it('filters in place to a method, replacing another', async () => {
    search = 'method=GET';
    renderApp(<TrafficPage />);
    const post = await screen.findByRole('button', { name: /^POST/ }, WAIT);
    fireEvent.click(post);
    expect(replace).toHaveBeenLastCalledWith('/analytics/traffic?method=POST', { scroll: false });
  });

  it('clears a method when it is clicked again', async () => {
    search = 'method=POST';
    renderApp(<TrafficPage />);
    const post = await screen.findByRole('button', { name: /^POST/ }, WAIT);
    expect(post.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(post);
    expect(replace).toHaveBeenLastCalledWith('/analytics/traffic', { scroll: false });
  });

  it('clears an exact status code when it is clicked again', async () => {
    search = 'status=429';
    renderApp(<TrafficPage />);
    const code = await screen.findByRole('button', { name: /^429/ }, WAIT);
    expect(code.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(code);
    expect(replace).toHaveBeenLastCalledWith('/analytics/traffic', { scroll: false });
  });

  it('shows a pressed row by more than colour: a check mark on a code, a rule and weight on a class or method', async () => {
    search = 'statusClass=5xx&status=429';
    renderApp(<TrafficPage />);
    const code = await screen.findByRole('button', { name: /^429/ }, WAIT);
    // A class and an exact code replace each other in the page's filters, so only the one in the URL
    // can be pressed; the class row is pressed too here only because the URL holds both.
    expect(code.querySelector('svg')).not.toBeNull();
    const idle = screen.getByRole('button', { name: /^200/ });
    expect(idle.querySelector('svg')).toBeNull();
    const server = screen.getByRole('button', { name: /Server error \(5xx\)/ });
    expect(server.className).toContain('border-s-2');
    expect(server.className).toContain('aria-pressed:border-foreground');
    expect(server.className).toContain('aria-pressed:font-medium');
  });

  it('labels each breakdown by its heading once, not by a second copy of the same words', async () => {
    renderApp(<TrafficPage />);
    await screen.findByRole('button', { name: /Server error \(5xx\)/ }, WAIT);
    for (const name of [T.mix.byClass, T.mix.byMethod, T.mix.byCode]) {
      const region = screen.getByRole('region', { name });
      expect(region.hasAttribute('aria-label')).toBe(false);
      expect(region.getAttribute('aria-labelledby')).toBeTruthy();
    }
  });

  it('filters in place to an exact status code, instead of a class', async () => {
    search = 'statusClass=4xx';
    renderApp(<TrafficPage />);
    const code = await screen.findByRole('button', { name: /^429/ }, WAIT);
    fireEvent.click(code);
    expect(replace).toHaveBeenLastCalledWith('/analytics/traffic?status=429', { scroll: false });
  });

  it('filters in place without needing the search permission', async () => {
    granted = ['analytics:read'];
    renderApp(<TrafficPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Server error \(5xx\)/ }, WAIT));
    expect(replace).toHaveBeenCalledTimes(1);
  });
});

describe('traffic page: filtering in place is announced', () => {
  const spoken = () => screen.getAllByRole('status').map((el) => el.textContent);

  it('says how many requests match and how many filters apply, to assistive technology only', async () => {
    renderApp(<TrafficPage />);
    await waitFor(() => {
      expect(spoken()).toContain('5,000 requests · no filters');
    }, WAIT);
    const region = screen.getAllByRole('status').find((el) => el.textContent === '5,000 requests · no filters');
    expect(region?.className).toContain('sr-only');
  });

  it('counts the filters in the URL', async () => {
    search = 'method=POST&statusClass=5xx&minLatencyMs=500';
    renderApp(<TrafficPage />);
    await waitFor(() => {
      expect(spoken()).toContain('5,000 requests · 3 filters');
    }, WAIT);
  });

  it('says nothing about a filter while its results are still loading, then says the new count', async () => {
    const view = renderApp(<TrafficPage />);
    await waitFor(() => {
      expect(spoken()).toContain('5,000 requests · no filters');
    }, WAIT);
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    traffic = { ...baseTraffic, summary: { ...baseTraffic.summary, requests: 40 } };
    search = 'method=POST';
    view.rerender(<TrafficPage />);
    // The stale numbers are still on screen; the region keeps its last words rather than announcing them as new.
    await waitFor(() => {
      expect(calls.filter((c) => c.path.startsWith('/analytics/traffic')).length).toBeGreaterThan(1);
    }, WAIT);
    expect(spoken()).toContain('5,000 requests · no filters');
    expect(spoken()).not.toContain('5,000 requests · 1 filter');
    release();
    await waitFor(() => {
      expect(spoken()).toContain('40 requests · 1 filter');
    }, WAIT);
  });
});

describe('traffic page click-through: the endpoints', () => {
  const rowOfEndpoint = (name: RegExp) => screen.getByRole('rowheader', { name }).closest('tr') as HTMLElement;

  it("gives each endpoint a hidden link to its requests (exact path and method), and the path is the keyboard's link to it", async () => {
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const get = rowOfEndpoint(/^GET\s*\/v1\/orders/);
    const hidden = get.querySelector<HTMLAnchorElement>('a[data-row-link]');
    expect(hidden?.hidden).toBe(true);
    expect(q(hidden as HTMLElement)).toBe('route:/v1/orders method:GET');
    // The link is named with its method, which is a badge beside it, so two rows with one path differ.
    expect(q(within(get).getByRole('link', { name: 'GET /v1/orders' }))).toBe('route:/v1/orders method:GET');
    expect(screen.getByRole('link', { name: 'POST /v1/orders' })).toBeDefined();
  });

  it('follows the hidden link when the row is clicked, and not when its text is double-clicked', async () => {
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const get = rowOfEndpoint(/^GET\s*\/v1\/orders/);
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    get.querySelector('a[data-row-link]')?.addEventListener('click', clicked);
    const cell = within(get).getAllByText('700')[0];
    if (!cell) throw new Error('no 700 cell');
    withRowClock((pass) => {
      fireEvent.click(cell, { detail: 1 });
      fireEvent.click(cell, { detail: 2 });
      pass();
      expect(clicked).not.toHaveBeenCalled();
      fireEvent.click(cell, { detail: 1 });
      pass();
      expect(clicked).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the API in the search when the view is narrowed to one, and the other filters', async () => {
    search = `apiId=${API_ID}&statusClass=5xx`;
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/slow', undefined, WAIT);
    const slow = rowOfEndpoint(/\/v1\/slow/);
    expect(q(within(slow).getByRole('link', { name: 'GET /v1/slow' }))).toBe(
      `api:${API_ID} status:5xx route:/v1/slow method:GET`,
    );
  });

  it("replaces the page's own method and path filters with the endpoint's", async () => {
    search = 'method=DELETE&path=/other';
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const post = rowOfEndpoint(/^POST\s*\/v1\/orders/);
    expect(q(within(post).getByRole('link', { name: 'POST /v1/orders' }))).toBe('route:/v1/orders method:POST');
  });

  it('shows an endpoint whose path search cannot write as plain text, not as a link that lists more', async () => {
    traffic = { ...baseTraffic, topEndpoints: [endpoint('GET', '/v1/say"hi"'), endpoint('GET', '/v1/orders')] };
    renderApp(<TrafficPage />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    const odd = rowOfEndpoint(/say/);
    expect(within(odd).queryByRole('link')).toBeNull();
    expect(odd.querySelector('a[data-row-link]')).toBeNull();
    const fine = rowOfEndpoint(/^GET\s*\/v1\/orders/);
    expect(q(within(fine).getByRole('link', { name: 'GET /v1/orders' }))).toBe('route:/v1/orders method:GET');
  });
});
