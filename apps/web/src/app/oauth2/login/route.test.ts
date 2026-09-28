import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * WP21: LOGIN must be audited. `acceptLogin` is the one place a login actually succeeds (both the
 * "Hydra remembers this browser" fast path and the full Kratos-session path funnel through it), so
 * this exercises the fast path — the smaller setup of the two — and asserts the real route handler
 * writes a real `AuditLog` row, not a mock of the audit call itself.
 */

interface UserRow {
  id: string;
  email: string;
  status: string;
  kratosIdentityId: string | null;
  password: string | null;
}

const auditCreate = vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>().mockResolvedValue({});
const userFindUnique = vi.fn<(args: { where: Partial<UserRow> }) => Promise<UserRow | null>>();
const userUpdate = vi.fn<(args: { where: { id: string }; data: Partial<UserRow> }) => Promise<UserRow>>();
const userCreate = vi.fn<(args: { data: Omit<UserRow, 'id'> }) => Promise<UserRow>>();
const getOAuth2LoginRequest = vi.fn();
const acceptOAuth2LoginRequest =
  vi.fn<(args: { acceptOAuth2LoginRequest: { subject?: string } }) => Promise<{ redirect_to: string }>>();
const rejectOAuth2LoginRequest = vi.fn().mockResolvedValue({ redirect_to: 'http://localhost:33010/oauth2/auth?rejected' });

vi.mock('@open-gateway/database', () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate, create: userCreate },
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

/**
 * V1-USR-01 (AC-USR01.3, AC-USR01.8): the full Kratos-session path into `resolveOrProvisionUser`'s
 * email branch — a User row that exists but is not bound to this identity yet (an invite, or an
 * account from before Kratos). Kratos keeps `traits.email` exactly as typed but always lowercases
 * `verifiable_addresses[].value` (probed on the live stack, plan pre-mortem #3); `login` mirrors that.
 */
describe('GET /oauth2/login — Kratos session claiming an unbound User row by email', () => {
  let rows: UserRow[];

  beforeEach(() => {
    rows = [];
    // Exact, case-sensitive match — what Postgres does on `User.email @unique` (plain text, no
    // citext). A case-insensitive fake would hide the very bug these tests pin.
    userFindUnique.mockImplementation(({ where }) =>
      Promise.resolve(rows.find((r) => Object.entries(where).every(([k, v]) => r[k as keyof UserRow] === v)) ?? null),
    );
    userUpdate.mockImplementation(({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      return row ? Promise.resolve(Object.assign(row, data)) : Promise.reject(new Error(`no row ${where.id}`));
    });
    userCreate.mockImplementation(({ data }) => {
      const row = { id: `created-${String(rows.length)}`, ...data };
      rows.push(row);
      return Promise.resolve(row);
    });
    getOAuth2LoginRequest.mockResolvedValue({ skip: false });
    acceptOAuth2LoginRequest.mockResolvedValue({ redirect_to: 'http://localhost:33010/oauth2/auth?...' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function login(identityId: string, typedEmail: string, verified: boolean): Promise<Response> {
    const { kratosServer } = await import('@/lib/kratos-server');
    (kratosServer.toSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      identity: {
        id: identityId,
        traits: { email: typedEmail, name: 'Test User' },
        verifiable_addresses: [{ value: typedEmail.toLowerCase(), verified }],
      },
    });
    const { GET } = await import('./route');
    return GET(request());
  }

  function expectAcceptedAs(subject: string): void {
    expect(acceptOAuth2LoginRequest.mock.calls[0]?.[0].acceptOAuth2LoginRequest.subject).toBe(subject);
    expect(rejectOAuth2LoginRequest).not.toHaveBeenCalled();
  }

  function expectRefused(): void {
    expect(rejectOAuth2LoginRequest).toHaveBeenCalledTimes(1);
    expect(acceptOAuth2LoginRequest).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  }

  const pending = (email: string): UserRow => ({
    id: 'invited-1',
    email,
    status: 'ACTIVE',
    kratosIdentityId: null,
    password: null,
  });

  describe('a pre-created (kratosIdentityId: null) row — AC-USR01.3', () => {
    it('binds the row once this identity has verified the address', async () => {
      rows.push(pending('dana@example.com'));

      await login('kratos-dana', 'dana@example.com', true);

      expectAcceptedAs('invited-1');
      expect(rows).toEqual([expect.objectContaining({ id: 'invited-1', kratosIdentityId: 'kratos-dana' })]);
      expect(userCreate).not.toHaveBeenCalled();
    });

    it('refuses while the address is still unverified on this identity', async () => {
      rows.push(pending('dana@example.com'));

      await login('kratos-dana', 'dana@example.com', false);

      expectRefused();
      expect(rows[0]?.kratosIdentityId).toBeNull();
    });

    it('refuses a second identity once a different one has claimed that email first', async () => {
      rows.push({ ...pending('dana@example.com'), kratosIdentityId: 'kratos-first' });

      await login('kratos-second', 'dana@example.com', true);

      expectRefused();
      expect(rows[0]?.kratosIdentityId).toBe('kratos-first');
    });
  });

  describe('mixed-case email typed at registration — AC-USR01.8', () => {
    it('an invite stored as bob@x.com is claimed by an identity that typed Bob@X.com — one row, bound', async () => {
      rows.push(pending('bob@x.com'));

      await login('kratos-bob', 'Bob@X.com', true);

      expectAcceptedAs('invited-1');
      expect(rows).toEqual([expect.objectContaining({ id: 'invited-1', kratosIdentityId: 'kratos-bob' })]);
      expect(userCreate).not.toHaveBeenCalled();
    });

    it('a plain existing account (not an invite) is claimed the same way, so the fix is not invite-specific', async () => {
      // An account from before Kratos (has a password hash, never invited), stored in the canonical
      // lowercase form every write uses from now on — and the form the pending backfill gives the
      // rows still stored mixed-case (see the fix in route.ts).
      rows.push({ id: 'legacy-carol', email: 'carol@example.com', status: 'ACTIVE', kratosIdentityId: null, password: 'bcrypt-hash' });

      await login('kratos-carol', 'Carol@Example.com', true);

      expectAcceptedAs('legacy-carol');
      expect(rows).toEqual([expect.objectContaining({ id: 'legacy-carol', kratosIdentityId: 'kratos-carol' })]);
      expect(userCreate).not.toHaveBeenCalled();
    });

    it('a brand-new mixed-case registration is created with the lowercased email', async () => {
      await login('kratos-erin', 'Erin@Example.com', false);

      expectAcceptedAs('created-0');
      expect(rows).toEqual([expect.objectContaining({ email: 'erin@example.com', kratosIdentityId: 'kratos-erin' })]);
    });
  });
});
