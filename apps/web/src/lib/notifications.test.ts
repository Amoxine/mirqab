import { describe, expect, it } from 'vitest';
import type { AnalyticsHealth, GatewayStatus } from '@/types';
import { deriveNotifications } from './notifications';

const gateway = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  gateway: { reachable: true, version: 'v5', latencyMs: 3, redis: 'pass', error: null },
  apis: { total: 2, synced: 2, pending: 0, failed: 0 },
  failedSyncs: [],
  ...over,
});
const health = (over: Partial<AnalyticsHealth> = {}): AnalyticsHealth => ({
  pipelineReady: true,
  pumpReachable: true,
  rawTablePresent: true,
  aggregateTablePresent: true,
  lastRecordAt: null,
  rowCount: 10,
  ...over,
});

describe('deriveNotifications', () => {
  it('is empty when everything is healthy, and when the user may read nothing', () => {
    expect(deriveNotifications({ gateway: gateway(), specUpdates: [], health: health() })).toEqual([]);
    expect(deriveNotifications({})).toEqual([]);
  });

  it('does not flag a fresh install whose tables exist but hold no rows', () => {
    expect(deriveNotifications({ health: health({ rowCount: 0, pipelineReady: false }) })).toEqual([]);
  });

  it('puts outages first, then the newest events, each with a link and a stable id', () => {
    const list = deriveNotifications({
      gateway: gateway({
        gateway: { reachable: false, version: null, latencyMs: null, redis: 'unknown', error: 'refused' },
        failedSyncs: [{ id: 'a1', name: 'Orders', slug: 'orders', syncError: 'x', lastSyncedAt: '2026-10-01T08:00:00Z' }],
      }),
      specUpdates: [{ apiId: 'a2', apiName: 'Pay', candidateId: 'c9', detectedAt: '2026-10-01T09:00:00Z', diff: { added: 1, removed: 0, changed: 0, governedRemoved: 0, governedChanged: 0 } }],
      health: health({ rawTablePresent: false }),
    });
    expect(list.map((n) => [n.kind, n.id, n.href])).toEqual([
      ['gatewayDown', 'gateway-down', '/settings'],
      ['pipelineDown', 'pipeline-down', '/analytics'],
      ['specUpdate', 'spec-update:c9', '/apis/a2?tab=endpoints'],
      ['syncFailed', 'sync-failed:a1:2026-10-01T08:00:00Z', '/apis/a1'],
    ]);
  });
});
