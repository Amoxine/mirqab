import { describe, expect, it } from 'vitest';
import type { AnalyticsHealth } from '../../types';
import { isPipelineStale } from './pipeline-status';

const healthy: AnalyticsHealth = {
  pipelineReady: true,
  pumpReachable: true,
  rawTablePresent: true,
  aggregateTablePresent: true,
  lastRecordAt: '2026-09-19T13:58:48.907Z',
  rowCount: 42,
};

describe('isPipelineStale', () => {
  it('is true only when the pump is down while the tables still hold rows', () => {
    expect(isPipelineStale({ ...healthy, pipelineReady: false, pumpReachable: false })).toBe(true);
  });

  it('is false for a live pump, so an idle gateway with old rows is never flagged', () => {
    expect(isPipelineStale(healthy)).toBe(false);
  });

  it('is false when there is nothing to show as stale', () => {
    const down = { ...healthy, pipelineReady: false, pumpReachable: false };
    expect(isPipelineStale({ ...down, rowCount: 0 })).toBe(false);
    expect(isPipelineStale({ ...down, rawTablePresent: false })).toBe(false);
    expect(isPipelineStale({ ...down, aggregateTablePresent: false })).toBe(false);
  });
});
