import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * WP21: LOGIN must be audited. `acceptLogin` is the one place a login actually succeeds (both the
 * "Hydra remembers this browser" fast path and the full Kratos-session path funnel through it), so
 * this exercises the fast path — the smaller setup of the two — and asserts the real route handler
 * writes a real `AuditLog` row, not a mock of the audit call itself.
 */

const auditCreate = vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>().mockResolvedValue({});
const getOAuth2LoginRequest = vi.fn();
const acceptOAuth2LoginRequest = vi.fn();
const rejectOAuth2LoginRequest = vi.fn().mockResolvedValue({ redirect_to: 'http://localhost:33010/oauth2/auth?rejected' });

vi.mock('@open-gateway/database', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { create: auditCreate },
  },
  // audit-log.ts's null sentinel for a nullable Json column — see AuditService.record's own comment.
  Prisma: { DbNull: 'DbNull-sentinel' },
}));

vi.mock('@/lib/hydra-admin', () => ({
  APP_URL: 'http://localhost:33000',
  hydraAdmin: { getOAuth2LoginRequest, acceptOAuth2LoginRequest, rejectOAuth2LoginRequest },
  oauthError: (code: string) => new Response(null, { status: 302, headers: { location: `/oauth2/error?error=${code}` } }),
}));

vi.mock('@/lib/kratos-server', () => ({ kratosServer: { toSession: vi.fn() } }));
vi.mock('@/lib/kratos-client', () => ({ KRATOS_PUBLIC_URL: 'http://kratos:4433' }));

function request(loginChallenge = 'challenge-1'): NextRequest {
  return new NextRequest(`http://localhost:33000/oauth2/login?login_challenge=${loginChallenge}`, {
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
}

describe('GET /oauth2/login — remembered-browser fast path', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('audits LOGIN once Hydra accepts the remembered session', async () => {
    const { prisma } = await import('@open-gateway/database');
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'ACTIVE' });
    getOAuth2LoginRequest.mockResolvedValue({ skip: true, subject: 'user-42' });
    acceptOAuth2LoginRequest.mockResolvedValue({ redirect_to: 'http://localhost:33010/oauth2/auth?...' });

    const { GET } = await import('./route');
    const res = await GET(request());

    expect(res.status).toBe(307); // NextResponse.redirect
    expect(acceptOAuth2LoginRequest).toHaveBeenCalledWith(
      expect.objectContaining({ acceptOAuth2LoginRequest: { subject: 'user-42' } }),
    );
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const call = auditCreate.mock.calls[0];
    if (!call) throw new Error('unreachable: asserted above');
    const [{ data }] = call;
    expect(data).toMatchObject({
      tenantId: null,
      userId: 'user-42',
      action: 'LOGIN',
      resource: 'auth',
      ipAddress: '203.0.113.9',
    });
  });

  it('does not accept, and so does not audit, a remembered session for a suspended account', async () => {
    const { prisma } = await import('@open-gateway/database');
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SUSPENDED' });
    getOAuth2LoginRequest.mockResolvedValue({ skip: true, subject: 'user-42' });

    const { GET } = await import('./route');
    await GET(request());

    expect(acceptOAuth2LoginRequest).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
