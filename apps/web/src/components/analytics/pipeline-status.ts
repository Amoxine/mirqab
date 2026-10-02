import type { AnalyticsHealth } from '@/types';

/**
 * The pump is down but earlier rows exist: keep showing them (as stale) under `AnalyticsStaleNotice`
 * instead of replacing the whole page with the empty state.
 */
export const isPipelineStale = (health: AnalyticsHealth): boolean =>
  !health.pumpReachable && health.rawTablePresent && health.aggregateTablePresent && health.rowCount > 0;
