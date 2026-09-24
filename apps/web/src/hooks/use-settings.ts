import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { GatewayReloadOutcome, NodeHealthEntry, TenantSettings } from '@/types';

/** `GET /settings` — read-only tykOrgId + analytics retention windows (config, never edited here). */
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: () => api.get<TenantSettings>('/settings').then((res) => res.data),
  });
}

/** `GET /gateway/nodes/health` — read-only /hello for every configured node (U17: no node CRUD). */
export function useNodeHealth() {
  return useQuery({
    queryKey: queryKeys.gateway.nodeHealth,
    queryFn: () => api.get<NodeHealthEntry[]>('/gateway/nodes/health').then((res) => res.data),
  });
}

/** `POST /gateway/reload` — the one platform-wide action a tenant admin has (settings:update). */
export function useReloadGateways() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<GatewayReloadOutcome[]>('/gateway/reload', {}).then((res) => res.data),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.gateway.nodeHealth }),
        qc.invalidateQueries({ queryKey: queryKeys.gateway.status }),
      ]);
    },
  });
}
