import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

/**
 * The distinction this route exists to get right: a refresh token Hydra REJECTED ends the session,
 * a Hydra that merely failed to answer does not. Before, any non-2xx cleared the cookies — so a
 * five-second Hydra restart signed out every active user and threw away refresh tokens that were
 * still perfectly good.
 */
function request(cookie = 'refresh_token=ory_rt_still_good'): NextRequest {
  return new NextRequest('http://localhost:33000/oauth2/refresh', { method: 'POST', headers: { cookie } });
}

function stubTokenEndpoint(answer: Response | Error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))),
  );
}

const cleared = (res: Response, name: string) =>
  res.headers.getSetCookie().some((c) => c.startsWith(`${name}=;`) || c.startsWith(`${name}=; `));

describe('POST /oauth2/refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renews the session on success', async () => {
    stubTokenEndpoint(
      Response.json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }, { status: 200 }),
    );

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('access_token=new-at'))).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('refresh_token=new-rt'))).toBe(true);
  });

  // Hydra answers a spent, rotated or revoked refresh token with 400 `invalid_grant`.
  it.each([400, 401])('ends the session when Hydra rejects the grant (%i)', async (status) => {
    stubTokenEndpoint(Response.json({ error: 'invalid_grant' }, { status }));

    const res = await POST(request());

    expect(res.status).toBe(401);
    expect(cleared(res, 'access_token')).toBe(true);
    expect(cleared(res, 'refresh_token')).toBe(true);
  });

  it.each([429, 500, 502, 503])('keeps the session when Hydra itself is failing (%i)', async (status) => {
    stubTokenEndpoint(new Response('', { status }));

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(cleared(res, 'access_token')).toBe(false);
    expect(cleared(res, 'refresh_token')).toBe(false);
  });

  it('keeps the session when the token endpoint is unreachable', async () => {
    stubTokenEndpoint(new Error('connect ECONNREFUSED 172.18.0.4:4444'));

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(cleared(res, 'refresh_token')).toBe(false);
  });

  it('401s without calling Hydra when there is no refresh token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(request(''));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
