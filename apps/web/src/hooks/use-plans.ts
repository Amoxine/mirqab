import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export type QuotaPeriod = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** `GET|POST|PATCH /plans*` (U9). `keyCount` is how many keys this plan governs. */
export interface Plan {
  id: string;
  name: string;
  description: string | null;
  rate: number;
  per: number;
  quotaMax: number;
  quotaPeriod: QuotaPeriod;
  active: boolean;
  keyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanFormPayload {
  name: string;
  description?: string;
  /** 0 = unlimited */
  rate?: number;
  per?: number;
  /** -1 = unlimited */
  quotaMax?: number;
  quotaPeriod?: QuotaPeriod;
  active?: boolean;
}

function invalidatePlans(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.plans.all });
}

export function usePlans() {
  return useQuery({
    queryKey: queryKeys.plans.all,
    queryFn: () => api.get<Plan[]>('/plans').then((res) => res.data),
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PlanFormPayload) => api.post<Plan>('/plans', data).then((res) => res.data),
    onSuccess: () => invalidatePlans(qc),
  });
}

export function useUpdatePlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PlanFormPayload) => api.patch<Plan>(`/plans/${id}`, data).then((res) => res.data),
    onSuccess: () => invalidatePlans(qc),
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ message: string; unassignedKeys: number }>(`/plans/${id}`).then((res) => res.data),
    onSuccess: () => invalidatePlans(qc),
  });
}
