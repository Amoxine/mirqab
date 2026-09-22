/**
 * Ory Keto client — the authority for "may this identity act in this tenant".
 *
 * The model is the one WP1 loaded (infra/ory/keto/namespaces.ts): namespace `Tenant` (capitalised,
 * case sensitive) with stored relations `member`/`admin` and the computed permits `view`
 * (member OR admin) and `manage` (admin only). Both are asked through the same check endpoint.
 *
 * Deliberately not a Nest provider: TenantService and AuthService reach for the `prisma` singleton
 * the same way, and a provider would mean wiring three modules for two functions.
 *
 * Read per call, not at import: ConfigModule loads infra/.env after this module is evaluated.
 */

const NAMESPACE = 'Tenant';

/**
 * `ketoCheck` runs on EVERY authenticated request, so an unbounded call means one half-open
 * connection to Keto pins request handlers until they run out.
 */
const KETO_TIMEOUT_MS = 5000;

/** Permits are computed at check time; relations are stored tuples. Both answer `check`. */
export type TenantPermit = 'view' | 'manage';
export type TenantRelation = 'member' | 'admin';

const readUrl = (): string => process.env.ORY_KETO_READ_URL ?? 'http://keto:4466';
const writeUrl = (): string => process.env.ORY_KETO_WRITE_URL ?? 'http://keto:4467';

/**
 * `admin` for the roles that administer a tenant, `member` for the rest. Postgres keeps the finer
 * grained role name (`viewer` vs `operator`) because that is what maps to the 27 permission names;
 * Keto only needs to know whether the subject belongs to the tenant at all.
 */
export const relationForRole = (role: string): TenantRelation =>
  ['admin', 'super_admin'].includes(role.toLowerCase()) ? 'admin' : 'member';

/**
 * Answers `check(Tenant:<tenantId>#<permit>@<userId>)`.
 *
 * Keto replies 200 `{"allowed":true}` or 403 `{"allowed":false}` — a 403 is an answer, not an error.
 * Anything else throws: an unreachable Keto must surface as a 500, not as a silent "denied" that
 * looks to the caller like a revoked membership.
 */
export const ketoCheck = async (
  tenantId: string,
  permit: TenantPermit,
  userId: string,
): Promise<boolean> => {
  const url = new URL('/relation-tuples/check', readUrl());
  url.searchParams.set('namespace', NAMESPACE);
  url.searchParams.set('object', tenantId);
  url.searchParams.set('relation', permit);
  url.searchParams.set('subject_id', userId);

  const response = await fetch(url, { signal: AbortSignal.timeout(KETO_TIMEOUT_MS) });
  if (response.status !== 200 && response.status !== 403) {
    throw new Error(`Keto check failed: ${String(response.status)} ${await response.text()}`);
  }

  // A body with no verdict (or one that isn't JSON — `json()` throws on its own) is not a "no":
  // same reason an unreachable Keto throws rather than reading as a revoked membership.
  const { allowed } = (await response.json()) as { allowed?: boolean };
  if (typeof allowed !== 'boolean') {
    throw new Error(`Keto check returned no verdict: ${String(response.status)}`);
  }
  return allowed;
};

/**
 * Writes a membership tuple. Idempotent — Keto's PUT is an upsert, so re-running a seed or a
 * migration does not need a guard.
 */
export const ketoWriteMembership = async (
  tenantId: string,
  relation: TenantRelation,
  userId: string,
): Promise<void> => {
  const response = await fetch(new URL('/admin/relation-tuples', writeUrl()), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      namespace: NAMESPACE,
      object: tenantId,
      relation,
      subject_id: userId,
    }),
    signal: AbortSignal.timeout(KETO_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Keto tuple write failed: ${String(response.status)} ${await response.text()}`,
    );
  }
};

/**
 * Deletes a membership tuple — the other half of a role change or a member removal. Without this,
 * demoting or removing a member in Postgres left their old Keto relation in place, which still
 * grants `view`/`manage`: a role change is a delete-then-write, never a write alone.
 *
 * Idempotent — deleting a tuple that isn't there is not an error, so this is also safe to call
 * speculatively.
 */
export const ketoDeleteMembership = async (
  tenantId: string,
  relation: TenantRelation,
  userId: string,
): Promise<void> => {
  const url = new URL('/admin/relation-tuples', writeUrl());
  url.searchParams.set('namespace', NAMESPACE);
  url.searchParams.set('object', tenantId);
  url.searchParams.set('relation', relation);
  url.searchParams.set('subject_id', userId);

  const response = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(KETO_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(
      `Keto tuple delete failed: ${String(response.status)} ${await response.text()}`,
    );
  }
};
