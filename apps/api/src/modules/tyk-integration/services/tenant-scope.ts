import { prisma } from '@open-gateway/database';

/**
 * Everything about a tenant that gets stamped onto its gateway state (WP12c).
 *
 * `tykOrgId` scopes definitions, policies and keys so `POST /tyk/org/keys {is_inactive:true}` cuts
 * off exactly one tenant. Tyk's OrganizationMonitor keys off the API *definition's* `org_id`, not
 * the key's — verified on 5.15.0 with a key minted in a live org, which a cut-off API still refuses
 * — so the org has to reach the definition, not just the key, or the cutoff silently does nothing.
 *
 * `slug` namespaces the listen path (`/{slug}{listenPath}`), which is what lets two tenants own the
 * same path.
 */
export interface TenantGatewayScope {
  tykOrgId: string;
  slug: string;
}

/**
 * The single place any gateway write resolves a tenant's org from.
 *
 * It exists because the org has to be stamped identically by five separate writers — the API
 * definition, its JWT policy, an OAuth2 client's policy, and both key paths (create and update).
 * Each of those used to read `process.env.TYK_ORG_ID` for itself, which is how every tenant ended up
 * sharing one org; routing them all through here is what stops one of them silently drifting back.
 *
 * `tenantId` is a non-null FK everywhere this is called, so a miss is a bug, not a 404 — hence
 * `findUniqueOrThrow`.
 */
export async function loadTenantScope(tenantId: string): Promise<TenantGatewayScope> {
  return prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { tykOrgId: true, slug: true },
  });
}
