import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { AnalyticsRange, ApiKeyStatus, PaginatedResponse } from '@/types';

export type QuotaPeriod = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** `GET /keys` list item; `apiDefName` is the name of the API the key is scoped to. */
export interface ApiKey {
  id: string;
  name: string;
  status: ApiKeyStatus;
  apiDefId: string | null;
  apiDefName: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Live limits read from the gateway (spec §5.3). */
export interface KeyTyk {
  rate: number;
  per: number;
  quotaMax: number;
  quotaRemaining: number;
  /** seconds between quota resets */
  quotaRenewalRate: number;
  /** epoch seconds (Tyk `quota_renews`) or an ISO string */
  quotaRenewsAt: number | string | null;
}

/** `GET /keys/:id`. `tyk` is `null` (not an error) when the gateway is unreachable. */
export interface KeyDetail {
  id: string;
  name: string;
  status: ApiKeyStatus;
  apiDefId: string | null;
  apiDefName: string | null;
  expiresAt: string | null;
  createdAt: string;
  tyk: KeyTyk | null;
}

/** `POST /keys` response — `keyValue` is the raw key and is returned exactly once. */
export interface KeyCreated {
  id: string;
  name: string;
  status: ApiKeyStatus;
  apiDefId: string | null;
  expiresAt: string | null;
  createdAt: string;
  keyValue: string;
}

/** `GET /keys/:id/usage`. Quota fields are `null` when the gateway is unreachable or no quota is set. */
export interface KeyUsage {
  range: AnalyticsRange;
  requests: number;
  errors: number;
  /** percentage 0-100 */
  errorRate: number;
  avgLatencyMs: number;
  quotaMax: number | null;
  quotaRemaining: number | null;
  quotaResetAt: number | string | null;
}

export interface CreateKeyPayload {
  name: string;
  apiDefId: string;
  /** ISO 8601 — only sent when set */
  expiresAt?: string;
  rateLimitPerSecond?: number;
  quotaLimit?: number;
  quotaPeriod?: QuotaPeriod;
}

export interface UpdateKeyPayload {
  name: string;
  /** ISO 8601, or `null` to remove the expiry */
  expiresAt: string | null;
  /** 0 = unlimited */
  rateLimitPerSecond: number;
  /** 0 = remove the quota (then `quotaPeriod` is omitted) */
  quotaLimit: number;
  quotaPeriod?: QuotaPeriod;
}

/** A key change also changes the owning API's `keyCount` and keys tab, so refresh those with the key lists. */
function invalidateKeys(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.keys.all }),
    qc.invalidateQueries({ queryKey: queryKeys.apis.all }),
  ]);
}

export function useKeys(page = 1, pageSize = 20, status?: string, apiDefId?: string) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  if (apiDefId) params.set('apiDefId', apiDefId);

  return useQuery({
    queryKey: queryKeys.keys.list(Object.fromEntries(params)),
    queryFn: () =>
      api.get<PaginatedResponse<ApiKey>>(`/keys?${params.toString()}`).then((res) => res.data),
  });
}

export function useKey(id: string) {
  return useQuery({
    queryKey: queryKeys.keys.detail(id),
    queryFn: () => api.get<KeyDetail>(`/keys/${id}`).then((res) => res.data),
    enabled: !!id,
  });
}

export function useKeyUsage(id: string, range: AnalyticsRange) {
  return useQuery({
    queryKey: queryKeys.keys.usage(id, range),
    // This route returns `{ data: KeyUsage }`, which the api client wraps once more.
    queryFn: () =>
      api.get<{ data: KeyUsage }>(`/keys/${id}/usage?range=${range}`).then((res) => res.data.data),
    enabled: !!id,
  });
}

export function useCreateKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateKeyPayload) =>
      api.post<KeyCreated>('/keys', data).then((res) => res.data),
    onSuccess: () => invalidateKeys(qc),
  });
}

export function useUpdateKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateKeyPayload }) =>
      api.patch<KeyDetail>(`/keys/${id}`, data).then((res) => res.data),
    onSuccess: () => invalidateKeys(qc),
  });
}

export function useRevokeKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/keys/${id}/revoke`, {}).then((res) => res.data),
    onSuccess: () => invalidateKeys(qc),
  });
}
