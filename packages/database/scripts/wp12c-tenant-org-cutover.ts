/**
 * WP12c — one-shot cutover of existing gateway state from the single shared Tyk org (`org123`) to
 * one org per tenant (`Tenant.tykOrgId`).
 *
 * Why a cutover rather than a code-only change: the org is baked into every definition, policy and
 * key already sitting on the gateway. New writes pick up the tenant's org on their own, but anything
 * written before this lands stays in the shared org, where `POST /tyk/org/keys {is_inactive:true}`
 * would still disable every tenant at once.
 *
 * Nothing is rewritten in place. Tyk is asked to DELETE each object and CREATE it again under the
 * new org, because an in-place `org_id` edit leaves the gateway's own indexes pointing at the old
 * one. The document that gets re-created is the gateway's CURRENT one, read back immediately before
 * the delete, with only `org_id` (and, for definitions, `proxy.listen_path`) changed — so this
 * cannot drift from whatever `mapToTykFormat` emits today.
 *
 * Policy ids are preserved. A Tyk policy id IS the Hydra client id for OAuth2 clients
 * (oauth-client-mapper.ts) and `og-jwt-<apiDefId>` for bring-your-own-JWKS APIs; re-creating one
 * under a new id would silently unbind every token that maps to it.
 *
 * Keys are wiped, not migrated. `createKey` returns the raw secret exactly once, so a re-created key
 * cannot be handed back to its owner — the honest outcome is to delete it gateway-side, clear
 * `tykKeyId`/`keyHash` so no row keeps a hash that resolves to nothing, and mark the row REVOKED so
 * it reads as dead rather than phantom-ACTIVE. Owners re-issue from the UI.
 *
 * `tyk_analytics` / `tyk_aggregated` are deliberately untouched: they are scoped by `apiid`, never
 * by org, so historical rows stay readable across the cutover.
 *
 * Idempotent. Re-running finds every object already in its tenant's org and makes no writes, so a
 * partial run (gateway died halfway) is safe to repeat.
 *
 * Usage:
 *   pnpm --filter @open-gateway/database exec tsx scripts/wp12c-tenant-org-cutover.ts [--dry-run]
 *
 * Env:
 *   TYK_ADMIN_URL      default http://127.0.0.1:33005/tyk  (control API; inside compose it is
 *                      http://tyk-gateway:8081/tyk — port 8081 is not published, so from the host
 *                      run this via a container on the compose network)
 *   TYK_ADMIN_SECRET   required; the gateway's TYK_GW_SECRET
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const ADMIN_URL = (process.env.TYK_ADMIN_URL ?? 'http://127.0.0.1:33005/tyk').replace(/\/$/, '');
const SECRET = process.env.TYK_ADMIN_SECRET ?? '';

type TykDoc = Record<string, unknown>;

async function tyk<T = TykDoc>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ADMIN_URL}${path}`, {
    ...init,
    headers: {
      'x-tyk-authorization': SECRET,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return (body ? JSON.parse(body) : {}) as T;
}

/** `/{tenantSlug}{listenPath}` — must stay identical to `gatewayListenPath` in api.service.ts. */
const gatewayListenPath = (slug: string, listenPath: string): string => `/${slug}${listenPath}`;

async function main(): Promise<void> {
  if (!SECRET) throw new Error('TYK_ADMIN_SECRET is required');
  console.log(`WP12c cutover${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);
  console.log(`  gateway: ${ADMIN_URL}`);

  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true, tykOrgId: true } });
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  console.log(`  tenants: ${tenants.length}`);

  const apiDefs = await prisma.apiDefinition.findMany({
    select: { id: true, tenantId: true, listenPath: true, tykApiId: true },
  });

  // tyk api_id -> owning tenant, so a policy can be traced to a tenant through its access_rights.
  const tenantByTykApiId = new Map<string, { id: string; slug: string; tykOrgId: string }>();
  for (const def of apiDefs) {
    const tenant = def.tykApiId ? tenantById.get(def.tenantId) : undefined;
    if (def.tykApiId && tenant) tenantByTykApiId.set(def.tykApiId, tenant);
  }

  // ─── 1. Definitions ────────────────────────────────────────────────
  let defsMoved = 0;
  let defsSkipped = 0;
  for (const def of apiDefs) {
    if (!def.tykApiId) continue;
    const tenant = tenantById.get(def.tenantId);
    if (!tenant) throw new Error(`api_definition ${def.id} has no tenant ${def.tenantId}`);

    let current: TykDoc;
    try {
      current = await tyk(`/apis/${def.tykApiId}`);
    } catch (err) {
      console.warn(`  ! definition ${def.tykApiId} not on the gateway, skipping (${String(err).slice(0, 120)})`);
      continue;
    }

    const wantPath = gatewayListenPath(tenant.slug, def.listenPath);
    const proxy = (current.proxy ?? {}) as TykDoc;
    if (current.org_id === tenant.tykOrgId && proxy.listen_path === wantPath) {
      defsSkipped += 1;
      continue;
    }

    const next: TykDoc = { ...current, org_id: tenant.tykOrgId, proxy: { ...proxy, listen_path: wantPath } };
    console.log(
      `  definition ${def.tykApiId}: org ${String(current.org_id)} -> ${tenant.tykOrgId}, ` +
        `path ${String(proxy.listen_path)} -> ${wantPath}`,
    );
    if (!DRY_RUN) {
      await tyk(`/apis/${def.tykApiId}`, { method: 'DELETE' });
      await tyk('/apis', { method: 'POST', body: JSON.stringify(next) });
    }
    defsMoved += 1;
  }

  // ─── 2. Policies (ids preserved) ───────────────────────────────────
  const policies = await tyk<TykDoc[]>('/policies');
  let polMoved = 0;
  let polSkipped = 0;
  let polOrphan = 0;
  for (const policy of Array.isArray(policies) ? policies : []) {
    const id = String(policy._id ?? policy.id ?? '');
    const accessRights = (policy.access_rights ?? {}) as Record<string, unknown>;
    const owner = Object.keys(accessRights)
      .map((apiId) => tenantByTykApiId.get(apiId))
      .find(Boolean);

    if (!owner) {
      // A policy granting nothing we can trace to a tenant cannot be assigned an org safely.
      console.warn(`  ! policy ${id} has no access_rights matching a known API — left as is, org ${String(policy.org_id)}`);
      polOrphan += 1;
      continue;
    }
    if (policy.org_id === owner.tykOrgId) {
      polSkipped += 1;
      continue;
    }

    console.log(`  policy ${id}: org ${String(policy.org_id)} -> ${owner.tykOrgId} (id preserved)`);
    if (!DRY_RUN) {
      await tyk(`/policies/${id}`, { method: 'DELETE' });
      // `id` is sent explicitly; the gateway honours it because TYK_GW_POLICIES_ALLOWEXPLICITPOLICYID.
      await tyk('/policies', { method: 'POST', body: JSON.stringify({ ...policy, id, org_id: owner.tykOrgId }) });
    }
    polMoved += 1;
  }

  // ─── 3. Keys: wipe gateway-side, mark the rows dead ────────────────
  const keys = await prisma.apiKey.findMany({
    where: { tykKeyId: { not: null } },
    select: { id: true, tykKeyId: true },
  });
  let keysWiped = 0;
  for (const key of keys) {
    if (!key.tykKeyId) continue;
    console.log(`  key ${key.id}: deleting gateway key and revoking the row`);
    if (!DRY_RUN) {
      try {
        await tyk(`/keys/${key.tykKeyId}?hashed=true`, { method: 'DELETE' });
      } catch (err) {
        // Already gone on the gateway is the desired end state, so this must not abort the run.
        console.warn(`    (gateway delete failed, continuing: ${String(err).slice(0, 120)})`);
      }
      await prisma.apiKey.update({
        where: { id: key.id },
        data: { tykKeyId: null, keyHash: null, status: 'REVOKED' },
      });
    }
    keysWiped += 1;
  }

  if (!DRY_RUN) await tyk('/reload/group');

  // ─── 4. Post-run assertion ─────────────────────────────────────────
  // `POST /tyk/reload/group` returns as soon as the signal is published, not when every node has
  // re-read its specs, and `GET /tyk/apis` serves the in-memory list — so immediately after a
  // re-create it can still answer with the pre-delete document. Without this retry the very first
  // (real) run reports "cutover incomplete" for a cutover that in fact succeeded. Verified against
  // v5.15.0: the stale read clears well inside one retry.
  const orgs = new Set(tenants.map((t) => t.tykOrgId));
  const strayDefsIn = (docs: TykDoc[]): TykDoc[] =>
    docs.filter((d) => tenantByTykApiId.has(String(d.api_id)) && !orgs.has(String(d.org_id)));
  const strayPolsIn = (docs: TykDoc[]): TykDoc[] =>
    docs.filter((p) => {
      const rights = Object.keys((p.access_rights ?? {}) as Record<string, unknown>);
      return rights.some((a) => tenantByTykApiId.has(a)) && !orgs.has(String(p.org_id));
    });
  const asArray = (v: unknown): TykDoc[] => (Array.isArray(v) ? (v as TykDoc[]) : []);

  let strayDefs: TykDoc[] = [];
  let strayPols: TykDoc[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    strayDefs = strayDefsIn(asArray(await tyk<TykDoc[]>('/apis')));
    strayPols = strayPolsIn(asArray(await tyk<TykDoc[]>('/policies')));
    if (strayDefs.length === 0 && strayPols.length === 0) break;
  }

  console.log(
    `\n  definitions: ${defsMoved} moved, ${defsSkipped} already correct` +
      `\n  policies:    ${polMoved} moved, ${polSkipped} already correct, ${polOrphan} untraceable` +
      `\n  keys:        ${keysWiped} wiped` +
      `\n  tenant orgs: ${[...orgs].join(', ')}`,
  );

  if (DRY_RUN) {
    console.log('\n  DRY RUN — nothing was written.');
    return;
  }
  if (strayDefs.length > 0 || strayPols.length > 0) {
    throw new Error(
      `cutover incomplete: ${strayDefs.length} definition(s) and ${strayPols.length} policy/policies ` +
        `still outside every tenant org (${[...orgs].join(', ')})`,
    );
  }
  console.log('  ✅ every tenant-owned definition and policy is in its tenant org.');
}

main()
  .catch((err: unknown) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
