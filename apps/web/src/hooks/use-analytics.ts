import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type {
  AnalyticsApiRow,
  AnalyticsHealth,
  AnalyticsKeyRow,
  AnalyticsMetric,
  AnalyticsOverview,
  AnalyticsRange,
  AnalyticsStatusCode,
  AnalyticsTimeSeriesPoint,
  AnalyticsTraffic,
  TrafficFilters,
} from '@/types';

/** Range selector options, in display order. Values are the `range` query param the API accepts. */
export const ANALYTICS_RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

export function useAnalyticsOverview(range: AnalyticsRange = '24h') {
  return useQuery({
    queryKey: queryKeys.analytics.overview(range),
    queryFn: () =>
      api.get<AnalyticsOverview>(`/analytics/overview?range=${range}`).then((res) => res.data),
  });
}

export function useAnalyticsTimeSeries(metric: AnalyticsMetric = 'requests', range: AnalyticsRange = '24h') {
  return useQuery({
    queryKey: queryKeys.analytics.timeseries(metric, range),
    queryFn: () =>
      api
        .get<AnalyticsTimeSeriesPoint[]>(`/analytics/timeseries?metric=${metric}&range=${range}`)
        .then((res) => res.data),
  });
}

export function useAnalyticsApis(range: AnalyticsRange = '24h') {
  return useQuery({
    queryKey: queryKeys.analytics.apis(range),
    queryFn: () => api.get<AnalyticsApiRow[]>(`/analytics/apis?range=${range}`).then((res) => res.data),
  });
}

export function useAnalyticsKeys(range: AnalyticsRange = '24h') {
  return useQuery({
    queryKey: queryKeys.analytics.keys(range),
    queryFn: () => api.get<AnalyticsKeyRow[]>(`/analytics/keys?range=${range}`).then((res) => res.data),
  });
}

export function useAnalyticsStatusCodes(range: AnalyticsRange = '24h') {
  return useQuery({
    queryKey: queryKeys.analytics.statusCodes(range),
    queryFn: () =>
      api.get<AnalyticsStatusCode[]>(`/analytics/status-codes?range=${range}`).then((res) => res.data),
  });
}

/** Filtered traffic KPIs, series and endpoint breakdowns. Empty filters are dropped from the query string. */
export function useAnalyticsTraffic(filters: TrafficFilters) {
  return useQuery({
    queryKey: queryKeys.analytics.traffic(filters),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== '') params.set(key, String(value));
      }
      return api.get<AnalyticsTraffic>(`/analytics/traffic?${params.toString()}`).then((res) => res.data);
    },
    // Keep the previous numbers on screen while a filter change loads, instead of flashing skeletons.
    placeholderData: (previous) => previous,
  });
}

/** Pump pipeline readiness. Cheap and range-independent: the home page uses it to decide whether analytics can be shown at all. */
export function useAnalyticsHealth() {
  return useQuery({
    queryKey: queryKeys.analytics.health,
    queryFn: () => api.get<AnalyticsHealth>('/analytics/health').then((res) => res.data),
  });
}
