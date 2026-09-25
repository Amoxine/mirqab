// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api-client';
import { setActiveTenantId } from './active-tenant';

const YAML = 'openapi: 3.0.3\ninfo:\n  title: "A: b"\n';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  setActiveTenantId('tenant-7');
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('api.postRaw', () => {
  it('sends the text verbatim with the given Content-Type and the tenant header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { success: true, data: { ok: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.postRaw<{ ok: number }>('/apis/import/preview', YAML, 'application/yaml');

    expect(res.data).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/apis/import/preview')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(YAML); // not JSON.stringify'd
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/yaml');
    expect(headers.get('X-Tenant-ID')).toBe('tenant-7');
  });

  it('goes through the 401 -> refresh -> replay path with the same raw body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { success: false, error: { message: 'expired' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // POST /oauth2/refresh
      .mockResolvedValueOnce(json(200, { success: true, data: 'replayed' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.postRaw<string>('/apis/api-1/spec?dryRun=true&expectedVersion=1', YAML, 'application/yaml');

    expect(res.data).toBe('replayed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/oauth2/refresh');
    const replay = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(replay.body).toBe(YAML);
    expect(new Headers(replay.headers).get('Content-Type')).toBe('application/yaml');
  });

  it('keeps JSON callers unchanged: api.post still JSON-encodes with application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { success: true, data: null }));
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/x', { a: 1 });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
});

describe('ApiRequestError.code', () => {
  it('carries error.code from the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(409, { success: false, error: { code: 'SPEC_VERSION_STALE', message: 'stale' } })));
    await expect(api.get('/x')).rejects.toMatchObject({ status: 409, code: 'SPEC_VERSION_STALE', message: 'stale' });
  });

  it('has no code when the body has none (or is not JSON)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })));
    const err: unknown = await api.get('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, message: 'HTTP 502' });
    expect((err as { code?: string }).code).toBeUndefined();
  });
});
