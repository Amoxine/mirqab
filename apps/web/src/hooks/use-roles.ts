import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/** `GET|POST|PATCH|DELETE /roles*` (U18) — a tenant-scoped role and the permission names it grants. */
export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  /** Members currently holding this role by name; `DELETE` is refused while this is > 0. */
  memberCount: number;
  createdAt: string;
}

export interface PermissionCatalogEntry {
  name: string;
  resource: string;
  action: string;
}

export interface RoleFormPayload {
  name: string;
  description?: string;
  /** Replaces the whole grant; omitted on PATCH leaves it unchanged. */
  permissions?: string[];
}

function invalidateRoles(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.roles.all });
}

export function useRoles() {
  return useQuery({
    queryKey: queryKeys.roles.all,
    queryFn: () => api.get<Role[]>('/roles').then((res) => res.data),
  });
}

/** The full permission catalogue the matrix renders — static per deployment, so a long staleTime is safe. */
export function usePermissionCatalog() {
  return useQuery({
    queryKey: queryKeys.roles.permissions,
    queryFn: () => api.get<PermissionCatalogEntry[]>('/roles/permissions').then((res) => res.data),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: RoleFormPayload) => api.post<Role>('/roles', data).then((res) => res.data),
    onSuccess: () => invalidateRoles(qc),
  });
}

export function useUpdateRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<RoleFormPayload>) => api.patch<Role>(`/roles/${id}`, data).then((res) => res.data),
    onSuccess: () => invalidateRoles(qc),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ message: string }>(`/roles/${id}`).then((res) => res.data),
    onSuccess: () => invalidateRoles(qc),
  });
}
