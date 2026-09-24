import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ACCESS_TOKEN_COOKIE } from '@/lib/oauth-cookies';

/** WP21: LOGOUT must be audited, and only on a VERIFIED logout — the same bar
 * `revokeOAuth2LoginSessions` already uses (a confirmed, active Hydra introspection). */

// vi.mock(...) factories are hoisted above regular imports/consts — vi.hoisted() is what lets these
// be declared early enough for the factories below to reference them without a TDZ error.
const { auditCreate, introspectOAuth2Token, revokeOAuth2LoginSessions } = vi.hoisted(() => ({
  auditCreate: vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>().mockResolvedValue({}),
  introspectOAuth2Token: vi.fn<() => Promise<{ active: boolean; sub?: string }>>(),
  revokeOAuth2LoginSessions: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('@open-gateway/database', () => ({
  prisma: { auditLog: { create: auditCreate } },
  Prisma: { DbNull: 'DbNull-sentinel' },
}));

vi.mock('@/lib/hydra-admin', () => ({
  hydraAdmin: { introspectOAuth2Token, revokeOAuth2LoginSessions },
}));

vi.mock('@/lib/kratos-server', () => ({
  kratosServer: { createBrowserLogoutFlow: vi.fn().mockResolvedValue({ logout_url: 'http://kratos/logout' }) },
}));

function request(cookie: string): NextRequest {
  return new NextRequest('http://localhost:33000/oauth2/session-logout', {
    method: 'POST',
    headers: { cookie, 'x-forwarded-for': '203.0.113.9' },
  });
}

describe('POST /oauth2/session-logout', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('audits LOGOUT once Hydra confirms the introspected token is active', async () => {
    introspectOAuth2Token.mockResolvedValue({ active: true, sub: 'user-42' });

    const { POST } = await import('./route');
    await POST(request(`${ACCESS_TOKEN_COOKIE}=live-token`));

    expect(revokeOAuth2LoginSessions).toHaveBeenCalledWith({ subject: 'user-42' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const call = auditCreate.mock.calls[0];
    if (!call) throw new Error('unreachable: asserted above');
    const [{ data }] = call;
    expect(data).toMatchObject({
      tenantId: null,
      userId: 'user-42',
      action: 'LOGOUT',
      resource: 'auth',
      ipAddress: '203.0.113.9',
    });
  });

  it('does not audit when there is no live token to introspect (nothing verified)', async () => {
    const { POST } = await import('./route');
    await POST(request(''));

    expect(revokeOAuth2LoginSessions).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('does not audit an inactive/expired token', async () => {
    introspectOAuth2Token.mockResolvedValue({ active: false });

    const { POST } = await import('./route');
    await POST(request(`${ACCESS_TOKEN_COOKIE}=stale-token`));

    expect(revokeOAuth2LoginSessions).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
