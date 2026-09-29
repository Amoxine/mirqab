'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ANALYTICS_RANGES } from '@/hooks/use-analytics';
import type { AnalyticsRange, TrafficFilters } from '@/types';

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
const AUTHS = ['authenticated', 'anonymous'] as const;

const asNumber = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/** Reads the traffic filters out of a query string, dropping anything that is not a known value. */
export function parseTrafficFilters(params: URLSearchParams): TrafficFilters {
  const range = params.get('range');
  const statusClass = params.get('statusClass');
  const auth = params.get('auth');
  return {
    range: ANALYTICS_RANGES.some((r) => r.value === range) ? (range as AnalyticsRange) : '24h',
    apiId: params.get('apiId') ?? undefined,
    keyId: params.get('keyId') ?? undefined,
    method: params.get('method') ?? undefined,
    statusClass: STATUS_CLASSES.find((c) => c === statusClass),
    status: asNumber(params.get('status')),
    path: params.get('path') ?? undefined,
    minLatencyMs: asNumber(params.get('minLatencyMs')),
    auth: AUTHS.find((a) => a === auth),
  };
}

const isEmpty = (value: unknown): boolean => value === undefined || value === '';

/**
 * The traffic page's filters, kept in the URL so a filtered view can be shared or bookmarked and
 * survives a reload. Changing an API also clears the key filter, which only makes sense per API.
 */
export function useTrafficFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();

  const filters = useMemo(() => parseTrafficFilters(new URLSearchParams(query)), [query]);

  const update = useCallback(
    (patch: Partial<TrafficFilters>) => {
      const next = new URLSearchParams(query);
      const merged: Partial<TrafficFilters> =
        'apiId' in patch ? { keyId: undefined, ...patch } : patch;
      for (const [key, value] of Object.entries(merged)) {
        if (isEmpty(value)) next.delete(key);
        else next.set(key, String(value));
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );

  const reset = useCallback(() => {
    const next = new URLSearchParams();
    if (filters.range !== '24h') next.set('range', filters.range);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filters.range, pathname, router]);

  return { filters, update, reset };
}
