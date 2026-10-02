import { usePermissions } from '@/hooks/use-permissions';

/**
 * Whether this user can open request search: its page needs both permissions (`analytics:read` and
 * `api:update`), so a figure only links there for someone who can get in, instead of ending on a
 * no-access page. The server enforces the same on the route itself.
 */
export function useCanSearchRequests(): boolean {
  const { can } = usePermissions();
  return can('analytics:read') && can('api:update');
}
