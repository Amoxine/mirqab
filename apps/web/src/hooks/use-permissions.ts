import { useCallback } from 'react';
import { useMe } from './use-me';

/**
 * Permission checks for the current user, sourced from `GET /auth/me`.
 * Mirrors the server guard: `super_admin` passes every check. This only decides what the UI shows —
 * the API enforces the same permissions on every route.
 */
export function usePermissions() {
  const { data: me, isLoading } = useMe();

  const can = useCallback(
    (permission: string): boolean => {
      if (!me) return false;
      if (me.roles.some((role) => role.toLowerCase() === 'super_admin')) return true;
      return me.permissions.includes(permission);
    },
    [me],
  );

  return { can, isLoading };
}
