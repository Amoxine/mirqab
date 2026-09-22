import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { AuthMe } from '@/types';

/** Shared `GET /auth/me` query — `useAuth` and `usePermissions` both read this same cached data. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: () => api.get<AuthMe>('/auth/me').then((res) => res.data),
    retry: false,
  });
}
