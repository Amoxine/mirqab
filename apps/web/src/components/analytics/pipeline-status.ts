import type { AnalyticsHealth } from '@/types';

/**
 * The pump is down but earlier rows exist: keep showing them (as stale) under `AnalyticsStaleNotice`
 * instead of replacing the whole page with the empty state.
 */
export const isPipelineStale = (health: AnalyticsHealth): boolean =>
  !health.pumpReachable && health.rawTablePresent && health.aggregateTablePresent && health.rowCount > 0;

export function pipelineHint(health: AnalyticsHealth): string {
  if (!health.pumpReachable) {
    return 'Tyk Pump is not running or cannot be reached, so new requests are not being recorded. Start the tyk-pump service.';
  }
  if (!health.rawTablePresent || !health.aggregateTablePresent) {
    return 'Tyk Pump has not created its analytics tables yet. Make sure the tyk-pump service is running.';
  }
  return 'The analytics tables exist but no requests have been recorded yet. Send traffic through the gateway to populate them.';
}
