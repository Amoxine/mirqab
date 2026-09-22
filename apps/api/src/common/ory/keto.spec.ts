import { randomUUID } from 'node:crypto';
import {
  ketoCheck,
  ketoDeleteMembership,
  ketoWriteMembership,
  relationForRole,
} from './keto';

/**
 * Keto only stores whether a subject belongs to a tenant; the 27 permission names stay in Postgres.
 * So the four seeded roles collapse onto two relations, and the collapse must not accidentally hand
 * `manage` (admin-only) to a read-only role.
 */
describe('relationForRole', () => {
  it.each(['admin', 'super_admin', 'ADMIN', 'Super_Admin'])(
    'maps %s to the admin relation, whatever the casing of the free-form role column',
    (role) => {
      expect(relationForRole(role)).toBe('admin');
    },
  );

  it.each(['viewer', 'operator', 'something-a-tenant-invented'])(
    'maps %s to the member relation',
    (role) => {
      expect(relationForRole(role)).toBe('member');
    },
  );
});

/**
 * The 200-vs-403-vs-anything-else decision in ketoCheck is what every `:id` route on TenantController
 * now hangs off (TenantService#assertPermit), and every consumer mocks it. These specs test the
 * function itself, against a fake `fetch` so they run anywhere — the live-Keto suite below covers
 * the same ground against the real server when one is available.
 *
 * The distinction under test: a 403 is Keto's ANSWER ("not allowed"), anything else is a failure to
 * get an answer and must throw. A transport error read as `false` would look exactly like a revoked
 * membership and silently lock everyone out (or, on a write path, silently deny an admin).
 */
describe('Keto client error handling', () => {
  const realFetch = global.fetch;
  // Typed, so the URL assertion below reads `searchParams` off a URL and not off `any`.
  const fetchMock = jest.fn<Promise<Response>, [URL, RequestInit?]>();

  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.resetAllMocks();
  });

  const check = () => ketoCheck('t1', 'manage', 'u1');

  it('reads a 200 {"allowed":true} as allowed', async () => {
    fetchMock.mockResolvedValue(new Response('{"allowed":true}', { status: 200 }));

    await expect(check()).resolves.toBe(true);
  });

  it('reads a 403 {"allowed":false} as denied, not as an error', async () => {
    fetchMock.mockResolvedValue(new Response('{"allowed":false}', { status: 403 }));

    await expect(check()).resolves.toBe(false);
  });

  it.each([500, 404, 401])('throws on a %s rather than reporting a denial', async (status) => {
    fetchMock.mockResolvedValue(new Response('boom', { status }));

    await expect(check()).rejects.toThrow(`Keto check failed: ${String(status)}`);
  });

  it('throws when Keto is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(check()).rejects.toThrow('ECONNREFUSED');
  });

  it.each([
    ['a body that is not JSON', '<html>502 Bad Gateway</html>'],
    ['a 200 with no verdict field', '{}'],
    ['a verdict that is not a boolean', '{"allowed":"true"}'],
  ])('throws on %s', async (_name, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    await expect(check()).rejects.toThrow();
  });

  // The tuple writes have no "denied" case to mistake a failure for — but a swallowed failure here
  // is what TenantService's compensation (create/assignUser) and its demotion rollback key off.
  it.each([
    ['write', () => ketoWriteMembership('t1', 'admin', 'u1'), 'Keto tuple write failed'],
    ['delete', () => ketoDeleteMembership('t1', 'admin', 'u1'), 'Keto tuple delete failed'],
  ])('throws when the %s API answers non-2xx', async (_name, call, message) => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(call()).rejects.toThrow(message);
  });

  it.each([
    ['write', () => ketoWriteMembership('t1', 'admin', 'u1')],
    ['delete', () => ketoDeleteMembership('t1', 'admin', 'u1')],
  ])('throws when the %s API is unreachable', async (_name, call) => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(call()).rejects.toThrow('ECONNREFUSED');
  });

  it('asks about the namespace, object, permit and subject it was given', async () => {
    fetchMock.mockResolvedValue(new Response('{"allowed":true}', { status: 200 }));

    await ketoCheck('tenant-b', 'manage', 'user-a');

    const url = fetchMock.mock.calls[0][0];
    expect(Object.fromEntries(url.searchParams)).toEqual({
      namespace: 'Tenant',
      object: 'tenant-b',
      relation: 'manage',
      subject_id: 'user-a',
    });
  });
});

/**
 * The same client against the real server, which is what WP2 asked for: a mocked `fetch` cannot
 * catch a namespace that failed to load, a permit that does not compute the way namespaces.ts says,
 * or an API shape that moved between Keto versions.
 *
 * Opt-in, because CI has no Keto service (.github/workflows/ci.yml). Against the compose stack:
 *
 *   ORY_KETO_READ_URL=http://127.0.0.1:33014 \
 *   ORY_KETO_WRITE_URL=http://127.0.0.1:33015 \
 *   pnpm --filter @open-gateway/api exec jest src/common/ory
 *
 * Objects and subjects are fresh uuids per run and deleted afterwards, so this touches no real
 * tenant's tuples and needs no database.
 */
const liveKeto = Boolean(process.env.ORY_KETO_READ_URL && process.env.ORY_KETO_WRITE_URL);

(liveKeto ? describe : describe.skip)('Keto client against a live Keto', () => {
  const tenantId = `test-tenant-${randomUUID()}`;
  const admin = `test-admin-${randomUUID()}`;
  const member = `test-member-${randomUUID()}`;
  const stranger = `test-stranger-${randomUUID()}`;

  beforeAll(async () => {
    await ketoWriteMembership(tenantId, 'admin', admin);
    await ketoWriteMembership(tenantId, 'member', member);
  });

  afterAll(async () => {
    await ketoDeleteMembership(tenantId, 'admin', admin);
    await ketoDeleteMembership(tenantId, 'member', member);
  });

  it('grants view and manage to the admin relation', async () => {
    await expect(ketoCheck(tenantId, 'view', admin)).resolves.toBe(true);
    await expect(ketoCheck(tenantId, 'manage', admin)).resolves.toBe(true);
  });

  // The whole point of the permit split: a member reads, only an admin writes.
  it('grants view but NOT manage to the member relation', async () => {
    await expect(ketoCheck(tenantId, 'view', member)).resolves.toBe(true);
    await expect(ketoCheck(tenantId, 'manage', member)).resolves.toBe(false);
  });

  it('denies a subject with no tuple in the tenant', async () => {
    await expect(ketoCheck(tenantId, 'view', stranger)).resolves.toBe(false);
    await expect(ketoCheck(tenantId, 'manage', stranger)).resolves.toBe(false);
  });

  it('denies an admin of one tenant on another tenant', async () => {
    await expect(ketoCheck(`test-tenant-${randomUUID()}`, 'manage', admin)).resolves.toBe(false);
  });

  it('is idempotent: re-writing a tuple is an upsert, deleting a missing one is not an error', async () => {
    await expect(ketoWriteMembership(tenantId, 'admin', admin)).resolves.toBeUndefined();
    await expect(ketoDeleteMembership(tenantId, 'admin', stranger)).resolves.toBeUndefined();
    await expect(ketoCheck(tenantId, 'manage', admin)).resolves.toBe(true);
  });

  it('revokes manage as soon as the admin tuple is deleted', async () => {
    const demoted = `test-demoted-${randomUUID()}`;
    await ketoWriteMembership(tenantId, 'admin', demoted);
    await expect(ketoCheck(tenantId, 'manage', demoted)).resolves.toBe(true);

    await ketoDeleteMembership(tenantId, 'admin', demoted);

    // Delete-then-write (TenantService#updateMemberRole) is fail-closed precisely because this
    // takes effect immediately: mid-sequence the subject has nothing.
    await expect(ketoCheck(tenantId, 'manage', demoted)).resolves.toBe(false);
    await expect(ketoCheck(tenantId, 'view', demoted)).resolves.toBe(false);

    await ketoWriteMembership(tenantId, 'member', demoted);
    await expect(ketoCheck(tenantId, 'view', demoted)).resolves.toBe(true);
    await expect(ketoCheck(tenantId, 'manage', demoted)).resolves.toBe(false);
    await ketoDeleteMembership(tenantId, 'member', demoted);
  });

});
