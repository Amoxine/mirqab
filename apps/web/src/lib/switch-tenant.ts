import type { QueryClient } from '@tanstack/react-query';
import { getActiveTenantId, setActiveTenantId } from './active-tenant';
import { queryKeys } from './query-keys';

/**
 * Tenant switch (guidelines §8): cancel whatever is in flight, drop the previous tenant's cached
 * data, then change `X-Tenant-ID` — in that order, so no response for the old tenant can land in
 * the cache or on screen after the switch. The reload then re-resolves permissions, nav and every
 * tenant-scoped page from a clean slate, instead of hand-picking which queries to refetch.
 */
export async function switchTenant(
  queryClient: QueryClient,
  nextTenantId: string,
  reload: () => void = () => {
    window.location.reload();
  },
): Promise<void> {
  const previous = queryKeys.tenantScope(getActiveTenantId());
  await queryClient.cancelQueries({ queryKey: previous });
  queryClient.removeQueries({ queryKey: previous });
  setActiveTenantId(nextTenantId);
  reload();
}
