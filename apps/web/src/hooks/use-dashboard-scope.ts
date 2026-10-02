'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApis } from '@/hooks/use-apis';
import type { ApiDefinition } from '@/hooks/use-apis';
import { usePermissions } from '@/hooks/use-permissions';

export interface DashboardScope {
  /** The API every API card is narrowed to, or null for the gateway-wide view. */
  api: ApiDefinition | null;
  /** Scoped because it is the only managed API (cannot be cleared), not because someone picked it. */
  auto: boolean;
  select: (apiId: string) => void;
  clear: () => void;
}

/**
 * Which API the home dashboard's API cards describe: the only managed API, automatically, or the
 * one picked in the traffic table (`?api=<id>`, so a scoped view can be shared). Otherwise none.
 * The API list needs `api:read`; without it nothing is requested and there is no scope.
 */
export function useDashboardScope(): DashboardScope {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  const apis = useApis(1, 100, undefined, undefined, can('api:read'));

  const list = apis.data?.data ?? [];
  const only = apis.data?.meta.totalCount === 1 ? (list[0] ?? null) : null;
  const picked = list.find((item) => item.id === searchParams.get('api')) ?? null;

  const setParam = useCallback(
    (apiId: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (apiId) next.set('api', apiId);
      else next.delete('api');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return {
    api: only ?? picked,
    auto: only !== null,
    select: setParam,
    clear: () => {
      setParam(null);
    },
  };
}
