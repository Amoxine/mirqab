import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRefresh } from './refresh-retry';

const API = 'http://api.test/api';
const REFRESH = '/oauth2/refresh';
const json = (status: number) => new Response('{}', { status });

/** Answers per URL, in order; a path with no queued answer replies 200. Refresh calls go to
 * `REFRESH` (same-origin, not under `API`), so both URL shapes are keyed as-given. */
function stubFetch(answers: Record<string, Response[]>) {
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    const key = url.startsWith(API) ? url.slice(API.length) : url;
    return Promise.resolve(answers[key]?.shift() ?? json(200));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const calls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.map(([url]) => (url.startsWith(API) ? url.slice(API.length) : url));

describe('fetchWithRefresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes a non-401 straight through without refreshing', async () => {
    const fetchMock = stubFetch({ '/apis': [json(403)] });

    expect((await fetchWithRefresh(API, '/apis', {})).status).toBe(403);
    expect(calls(fetchMock)).toEqual(['/apis']);
  });

  it('on 401 refreshes once (POST, cookies included) and replays the request once', async () => {
    const fetchMock = stubFetch({ '/apis': [json(401), json(200)] });
    const init: RequestInit = { method: 'PATCH', body: '{"a":1}', credentials: 'include' };

    expect((await fetchWithRefresh(API, '/apis', init)).status).toBe(200);

    expect(calls(fetchMock)).toEqual(['/apis', REFRESH, '/apis']);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(fetchMock.mock.calls[2]?.[1]).toBe(init);
  });

  it('shares one refresh between concurrent 401s, then replays every request', async () => {
    const fetchMock = stubFetch({
      '/a': [json(401), json(200)],
      '/b': [json(401), json(200)],
      '/c': [json(401), json(200)],
    });

    const results = await Promise.all(['/a', '/b', '/c'].map((p) => fetchWithRefresh(API, p, {})));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls(fetchMock).filter((p) => p === REFRESH)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('starts a fresh refresh for a 401 that arrives after the previous one settled', async () => {
    const fetchMock = stubFetch({ '/a': [json(401), json(200)], '/b': [json(401), json(200)] });

    await fetchWithRefresh(API, '/a', {});
    await fetchWithRefresh(API, '/b', {});

    expect(calls(fetchMock).filter((p) => p === REFRESH)).toHaveLength(2);
  });

  it('returns the original 401 without replaying when the refresh is rejected', async () => {
    const fetchMock = stubFetch({ '/apis': [json(401)], [REFRESH]: [json(401)] });

    expect((await fetchWithRefresh(API, '/apis', {})).status).toBe(401);
    expect(calls(fetchMock)).toEqual(['/apis', REFRESH]);
  });

  it('treats a network failure during refresh as a failed refresh', async () => {
    const fetchMock = vi.fn((url: string) =>
      url === REFRESH ? Promise.reject(new TypeError('offline')) : Promise.resolve(json(401)),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect((await fetchWithRefresh(API, '/apis', {})).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after ONE replay: a second 401 is returned, not refreshed again', async () => {
    const fetchMock = stubFetch({ '/apis': [json(401), json(401)] });

    expect((await fetchWithRefresh(API, '/apis', {})).status).toBe(401);
    expect(calls(fetchMock)).toEqual(['/apis', REFRESH, '/apis']);
  });
});
