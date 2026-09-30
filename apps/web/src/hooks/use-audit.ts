import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { PaginatedResponse } from '@/types';

/** One row of `GET /audit-logs` as the API sends it (Prisma `AuditLog` + `user { name, email }`). */
export interface AuditLogEntry {
  id: string;
  /** Prisma `AuditAction` enum name, e.g. `SYNC_SUCCEEDED` (wider than the web `AuditAction` type). */
  action: string;
  resource: string;
  createdAt: string;
  user: { name: string | null; email: string } | null;
}

/** The most recent audit entries for the dashboard home. */
export function useRecentAudit(apiId?: string) {
  return useQuery({
    queryKey: [...queryKeys.audit.recent, { apiId: apiId ?? null }],
    queryFn: () =>
      api
        .get<PaginatedResponse<AuditLogEntry>>(`/audit-logs?page=1&pageSize=10${apiId ? `&apiId=${encodeURIComponent(apiId)}` : ''}`)
        .then((res) => res.data.data),
  });
}
