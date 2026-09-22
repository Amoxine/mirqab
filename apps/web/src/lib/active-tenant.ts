const STORAGE_KEY = 'og_active_tenant_id';

/**
 * Client-side-only "which tenant is active" preference, sent as the `X-Tenant-ID` header on every
 * API call (`api-client.ts`). Switching tenants is a pure client-side choice, not a server round
 * trip: apps/api resolves membership/permissions per-request from that header plus Postgres
 * `UserTenant` (see `TenantIsolationGuard` and `AuthService.resolveSession`'s `pickActiveTenant`) —
 * there is no session-baked tenant to update server-side.
 */
export function getActiveTenantId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenantId(tenantId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, tenantId);
  } catch {
    // Private browsing / blocked storage: the header is just omitted next time, falling back to
    // the server's own default-tenant pick — never worth failing the switch UI over.
  }
}
