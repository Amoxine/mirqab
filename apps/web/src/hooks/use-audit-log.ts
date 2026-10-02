import { useQuery } from '@tanstack/react-query';
import type { AuditLogEntry } from '@/hooks/use-audit';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/**
 * `GET /audit-logs/:id`: the list's row plus what the list page does not show. `details` is what the
 * API recorded for the action; it redacts secrets (keys that look like passwords, tokens, API keys)
 * and strips secrets from URLs before storing it, so showing it adds nothing the list does not hold.
 */
export interface AuditLogDetail extends AuditLogEntry {
  ipAddress: string | null;
  corrId: string | null;
  details: Record<string, unknown> | null;
}

/** One audit entry in full; asks for nothing while `id` is null (no entry is open). */
export function useAuditLog(id: string | null) {
  return useQuery({
    queryKey: queryKeys.audit.detail(id ?? ''),
    queryFn: () => api.get<AuditLogDetail>(`/audit-logs/${id ?? ''}`).then((res) => res.data),
    enabled: id !== null,
    // A missing or forbidden entry will not change on retry.
    retry: false,
  });
}
