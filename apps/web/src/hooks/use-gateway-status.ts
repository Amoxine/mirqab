import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { ApiSyncStatus, GatewayStatus } from '@/types';

/** The parts of `ApiDetail` (spec §5.2) that the sync retry reads from the response body. */
interface SyncResult {
  id: string;
  name: string;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
}

/** `GET /gateway/status` — gateway reachability plus API sync counts. Polled every 30 s (this query only). */
export function useGatewayStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.gateway.status,
    queryFn: () => api.get<GatewayStatus>('/gateway/status').then((res) => res.data),
    refetchInterval: 30_000,
    enabled,
  });
}

/**
 * Re-sync one API to the gateway. `POST /apis/:id/sync` always answers 200 with the refreshed API;
 * a failed sync is reported in `syncStatus` / `syncError`, so callers must inspect the resolved value.
 * Deliberately not shared with `use-apis.ts` (owned by the APIs pages).
 */
export function useRetrySync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SyncResult>(`/apis/${id}/sync`, {}).then((res) => res.data),
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.gateway.status }),
        qc.invalidateQueries({ queryKey: queryKeys.apis.all }),
      ]);
    },
  });
}
