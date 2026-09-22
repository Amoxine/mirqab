import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { QuotaPeriod } from '@/hooks/use-keys';

/** An OAuth2 client of one API (`GET /oauth-clients?apiDefId=`). Never carries the secret. */
export interface OAuthClient {
  clientId: string;
  name: string;
  apiDefId: string;
  createdAt: string | null;
}

/** Create / rotate response — the only time the raw secret exists outside Hydra. */
export interface OAuthClientSecret extends OAuthClient {
  clientSecret: string;
  tokenUrl: string;
}

export interface CreateOAuthClientPayload {
  name: string;
  apiDefId: string;
  rateLimitPerSecond?: number;
  quotaLimit?: number;
  quotaPeriod?: QuotaPeriod;
}

export function useOAuthClients(apiDefId: string) {
  return useQuery({
    queryKey: queryKeys.apis.clients(apiDefId),
    queryFn: () =>
      api
        .get<{ data: OAuthClient[] }>(`/oauth-clients?apiDefId=${apiDefId}`)
        .then((res) => res.data.data),
    enabled: !!apiDefId,
  });
}

export function useCreateOAuthClient(apiDefId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOAuthClientPayload) =>
      api.post<OAuthClientSecret>('/oauth-clients', data).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apis.clients(apiDefId) }),
  });
}

/** The client id survives a rotation, so only the secret changes — the list still needs no refetch. */
export function useRotateOAuthClient() {
  return useMutation({
    mutationFn: (clientId: string) =>
      api.post<OAuthClientSecret>(`/oauth-clients/${clientId}/rotate`, {}).then((res) => res.data),
  });
}

export function useRevokeOAuthClient(apiDefId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) => api.delete(`/oauth-clients/${clientId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apis.clients(apiDefId) }),
  });
}
