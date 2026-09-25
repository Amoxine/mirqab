import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type {
  ApiConfig,
  ApiHealthStatus,
  ApiKeyStatus,
  ApiStatus,
  ApiSyncStatus,
  OasDocument,
  PaginatedResponse,
} from '@/types';

/** While any API is still `PENDING` the gateway sync is in flight, so re-read until it settles. */
const SYNC_POLL_MS = 5000;

export interface ApiDefinition {
  id: string;
  name: string;
  slug: string;
  status: ApiStatus;
  authType: string;
  /** Not part of the `ApiDetail` contract (spec §5.2); present on list rows. */
  healthStatus?: ApiHealthStatus;
  proxyUrl: string;
  listenPath: string;
  tykApiId: string | null;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
  lastSyncedAt: string | null;
  config: ApiConfig | null;
  /** WP17: the generated Tyk OAS document. `null` for a CLASSIC-format API or one never synced. */
  oasDocument: OasDocument | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /apis/:id` (spec §5.2). */
export interface ApiDetail extends ApiDefinition {
  keyCount: number;
}

export interface CreateApiInput {
  name: string;
  slug: string;
  proxyUrl: string;
  listenPath: string;
  // JWT and HMAC are deliberately absent: JWT has no policy mapping the create/edit form offers
  // (api-form-schema.ts), and HMAC is WP15c-PARKED (no working signing-string variant) — the
  // Designer's Authentication Sheet offers exactly this set for the same reasons.
  authType: 'NONE' | 'AUTH_TOKEN' | 'OAUTH' | 'BASIC';
  config: ApiConfig;
}

/** The slug is immutable once created, so it is never sent on update. */
export type UpdateApiInput = Partial<Omit<CreateApiInput, 'slug'>>;

/** The subset of a key row the API pages render (`GET /keys?apiDefId=`). */
export interface ApiKeySummary {
  id: string;
  name: string;
  status: ApiKeyStatus;
  expiresAt: string | null;
  createdAt: string;
}

/** Anything that changes an API also changes the dashboard's gateway sync summary. */
function invalidateApis(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.apis.all }),
    qc.invalidateQueries({ queryKey: queryKeys.gateway.status }),
  ]);
}

export function useApis(page = 1, pageSize = 20, status?: string, syncStatus?: string) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  if (syncStatus) params.set('syncStatus', syncStatus);

  return useQuery({
    queryKey: queryKeys.apis.list(Object.fromEntries(params)),
    queryFn: () =>
      api.get<PaginatedResponse<ApiDefinition>>(`/apis?${params.toString()}`).then((res) => res.data),
    refetchInterval: (query) =>
      query.state.data?.data.some((item) => item.syncStatus === 'PENDING') ? SYNC_POLL_MS : false,
  });
}

export function useApiDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.apis.detail(id),
    queryFn: () => api.get<ApiDetail>(`/apis/${id}`).then((res) => res.data),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.syncStatus === 'PENDING' ? SYNC_POLL_MS : false),
  });
}

export function useApiKeys(id: string, pageSize = 50) {
  return useQuery({
    queryKey: queryKeys.apis.keys(id, pageSize),
    queryFn: () =>
      api
        .get<PaginatedResponse<ApiKeySummary>>(`/keys?apiDefId=${id}&pageSize=${String(pageSize)}`)
        .then((res) => res.data),
    enabled: !!id,
  });
}

export function useCreateApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateApiInput) => api.post<ApiDetail>('/apis', data).then((res) => res.data),
    onSuccess: () => invalidateApis(qc),
  });
}

export function useUpdateApi(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateApiInput) => api.patch<ApiDetail>(`/apis/${id}`, data).then((res) => res.data),
    onSuccess: () => invalidateApis(qc),
  });
}

export function useSetApiStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ApiStatus }) =>
      api.patch<ApiDetail>(`/apis/${id}`, { status }).then((res) => res.data),
    onSuccess: () => invalidateApis(qc),
  });
}

export function useDeleteApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/apis/${id}`).then((res) => res.data),
    onSuccess: (_data, id) => {
      // The row is gone: drop its detail cache instead of refetching a 404.
      qc.removeQueries({ queryKey: queryKeys.apis.detail(id) });
      return invalidateApis(qc);
    },
  });
}

/**
 * `POST /apis/:id/sync` always answers 200 with the refreshed `ApiDetail`; a failed gateway sync is
 * reported in the body (`syncStatus: 'FAILED'` + `syncError`), so callers read the body, not the status.
 */
export function useSyncApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApiDetail>(`/apis/${id}/sync`, {}).then((res) => res.data),
    onSuccess: () => invalidateApis(qc),
  });
}

/** `POST /apis/:id/debug` request body (Designer's "Test request"). */
export interface DebugRequestInput {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Overrides the upstream for this test only; validated by the same SSRF deny list as proxyUrl. */
  targetUrl?: string;
}

/** What `POST /tyk/debug` answers with — the upstream response plus the gateway's own log lines. */
export interface DebugResult {
  response?: { code?: number; headers?: Record<string, string>; body?: string };
  logs?: { mw?: string; msg?: string; level?: string }[];
  [key: string]: unknown;
}

/**
 * Runs a sample request against the API's own stored definition. No cache invalidation on success —
 * a test request changes nothing about the API itself, so there is nothing to refetch.
 */
export function useDebugApi(id: string) {
  return useMutation({
    mutationFn: (data: DebugRequestInput) => api.post<DebugResult>(`/apis/${id}/debug`, data).then((res) => res.data),
  });
}

export interface InvalidateCacheResult {
  invalidated: boolean;
  keysDropped: number;
}

/** `POST /apis/:id/cache/invalidate` — drops this API's cached responses on every gateway node. */
export function useInvalidateCache(id: string) {
  return useMutation({
    mutationFn: () =>
      api.post<InvalidateCacheResult>(`/apis/${id}/cache/invalidate`, {}).then((res) => res.data),
  });
}
