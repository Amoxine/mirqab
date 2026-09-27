import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { PaginatedResponse } from '@/types';
import type { QuotaPeriod } from './use-keys';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  plan: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  createdAt: string;
  updatedAt: string;
}

/** A row of `GET /tenants/:id/users`. `pending` is `kratosIdentityId === null` server-side: invited
 * but never yet claimed by a real sign-in. */
export interface TenantMember {
  userId: string;
  email: string;
  name: string;
  role: string;
  isDefault: boolean;
  pending: boolean;
  createdAt: string;
}

/** Result of `GET /tenants/:id/users/lookup`; `null` when no user has that email. */
export interface UserLookupResult {
  id: string;
  email: string;
  name: string;
  isMember: boolean;
}

/** `GET /tenants/:id/quota` — the org-level ceiling (U13/U14). `-1` is Tyk's "unlimited". */
export interface TenantQuota {
  tykOrgId: string;
  quotaMax: number | null;
  quotaRemaining: number | null;
  isInactive: boolean;
}

export interface SetTenantQuotaPayload {
  quotaMax: number;
  period?: QuotaPeriod;
  isInactive?: boolean;
}

/** `GET /tenants/:id/usage` — metered calls vs the plan allowance (U14's Usage tab). */
export interface TenantUsage {
  quotaMax: number | null;
  quotaRemaining: number | null;
  used: number | null;
  isInactive: boolean;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  plan?: Tenant['plan'];
}

/** The slug is immutable once created (same convention as APIs), so it is never sent on update. */
export type UpdateTenantInput = Partial<Pick<Tenant, 'name' | 'plan' | 'status'>>;

function invalidateTenants(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.tenants.all });
}

export function useTenants(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: queryKeys.tenants.list({ page: String(page), pageSize: String(pageSize) }),
    queryFn: () =>
      api
        .get<Tenant[]>(`/tenants?page=${String(page)}&pageSize=${String(pageSize)}`)
        // GET /tenants sends `{ success, data: Tenant[], meta }`, which the client passes through as-is.
        .then((res) => res as unknown as PaginatedResponse<Tenant>),
  });
}

export function useTenant(id: string) {
  return useQuery({
    queryKey: queryKeys.tenants.detail(id),
    queryFn: () => api.get<Tenant>(`/tenants/${id}`).then((res) => res.data),
    enabled: !!id,
  });
}

export interface TenantMembersParams {
  page?: number;
  pageSize?: number;
  /** Case-insensitive name/email substring filter. */
  q?: string;
}

export function useTenantMembers(id: string, { page = 1, pageSize = 20, q = '' }: TenantMembersParams = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) params.set('q', q);
  return useQuery({
    queryKey: queryKeys.tenants.members(id, Object.fromEntries(params.entries())),
    queryFn: () =>
      api
        .get<TenantMember[]>(`/tenants/${id}/users?${params.toString()}`)
        // Same envelope shape as GET /tenants: `{ success, data, meta }` passed through as-is.
        .then((res) => res as unknown as PaginatedResponse<TenantMember>),
    enabled: !!id,
    // Each search/page is a new key: without this the table flashes a skeleton and the pager drops to "of 1".
    placeholderData: keepPreviousData,
  });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTenantInput) => api.post<Tenant>('/tenants', data).then((res) => res.data),
    onSuccess: () => invalidateTenants(qc),
  });
}

export function useUpdateTenant(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateTenantInput) => api.patch<Tenant>(`/tenants/${id}`, data).then((res) => res.data),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: queryKeys.tenants.detail(id) }), invalidateTenants(qc)]),
  });
}

export function useArchiveTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<Tenant>(`/tenants/${id}`).then((res) => res.data),
    onSuccess: (_data, id) =>
      Promise.all([qc.invalidateQueries({ queryKey: queryKeys.tenants.detail(id) }), invalidateTenants(qc)]),
  });
}

/**
 * Looks up a user by email ahead of inviting them (a mutation, not a query: it's triggered by
 * form submit, not rendered reactively). Resolves to `null` when nobody matches — the common miss
 * is a user who registered but hasn't logged in yet, since the Postgres `User` row is only
 * provisioned on first login.
 */
export function useLookupUser(tenantId: string) {
  return useMutation({
    mutationFn: (email: string) =>
      api
        .get<UserLookupResult | null>(`/tenants/${tenantId}/users/lookup?email=${encodeURIComponent(email)}`)
        .then((res) => res.data),
  });
}

export function useInviteMember(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.post<TenantMember>(`/tenants/${tenantId}/users`, { userId, role }).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tenants.members(tenantId) }),
  });
}

/**
 * `POST :id/users/invite` (V1-USR-01, Option F): pre-creates a `User` row with no Kratos identity
 * yet — no email is sent by this app. The row shows as `pending: true` until the invitee registers
 * with this same email through Kratos's own self-service flow and verifies it.
 */
export function useInviteByEmail(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: string }) =>
      api.post<TenantMember>(`/tenants/${tenantId}/users/invite`, { email, role }).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tenants.members(tenantId) }),
  });
}

export function useUpdateMemberRole(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch<TenantMember>(`/tenants/${tenantId}/users/${userId}`, { role }).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tenants.members(tenantId) }),
  });
}

export function useRemoveMember(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/tenants/${tenantId}/users/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tenants.members(tenantId) }),
  });
}

export function useTenantQuota(id: string) {
  return useQuery({
    queryKey: queryKeys.tenants.quota(id),
    queryFn: () => api.get<TenantQuota>(`/tenants/${id}/quota`).then((res) => res.data),
    enabled: !!id,
  });
}

export function useSetTenantQuota(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SetTenantQuotaPayload) =>
      api.patch<TenantQuota>(`/tenants/${id}/quota`, data).then((res) => res.data),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tenants.quota(id) }),
        qc.invalidateQueries({ queryKey: queryKeys.tenants.usage(id) }),
      ]),
  });
}

export function useResetTenantQuota(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ tykOrgId: string; restored: boolean }>(`/tenants/${id}/quota/reset`, {}).then((res) => res.data),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tenants.quota(id) }),
        qc.invalidateQueries({ queryKey: queryKeys.tenants.usage(id) }),
      ]),
  });
}

export function useTenantUsage(id: string) {
  return useQuery({
    queryKey: queryKeys.tenants.usage(id),
    queryFn: () => api.get<TenantUsage>(`/tenants/${id}/usage`).then((res) => res.data),
    enabled: !!id,
  });
}
