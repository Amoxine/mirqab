import type { AnalyticsHealth, GatewayStatus } from '@/types';
import type { SpecUpdateItem } from '@/lib/api/spec-source';

/**
 * A notification is derived from what the API already reports; nothing is stored server-side.
 * The id changes when the underlying event does (a new failed sync, a new spec candidate), so a
 * notification marked read comes back only if the problem happens again.
 */
export type AppNotification =
  | { id: string; kind: 'gatewayDown'; href: string; at: null }
  | { id: string; kind: 'pipelineDown'; href: string; at: null }
  | { id: string; kind: 'syncFailed'; href: string; at: string | null; apiName: string }
  | { id: string; kind: 'specUpdate'; href: string; at: string; apiName: string };

interface Sources {
  gateway?: GatewayStatus;
  specUpdates?: SpecUpdateItem[];
  health?: AnalyticsHealth;
}

/** Outages first, then the newest events. Each source is optional: the user may lack its permission. */
export function deriveNotifications({ gateway, specUpdates, health }: Sources): AppNotification[] {
  const outages: AppNotification[] = [];
  if (gateway && !gateway.gateway.reachable) outages.push({ id: 'gateway-down', kind: 'gatewayDown', href: '/settings', at: null });
  // An empty pipeline (tables there, no rows yet) is a fresh install, not a problem.
  if (health && (!health.pumpReachable || !health.rawTablePresent || !health.aggregateTablePresent)) {
    outages.push({ id: 'pipeline-down', kind: 'pipelineDown', href: '/analytics', at: null });
  }

  const events: AppNotification[] = [
    ...(gateway?.failedSyncs ?? []).map((api) => ({
      id: `sync-failed:${api.id}:${api.lastSyncedAt ?? ''}`,
      kind: 'syncFailed' as const,
      href: `/apis/${api.id}`,
      at: api.lastSyncedAt,
      apiName: api.name,
    })),
    ...(specUpdates ?? []).map((u) => ({
      id: `spec-update:${u.candidateId}`,
      kind: 'specUpdate' as const,
      href: `/apis/${u.apiId}?tab=endpoints`,
      at: u.detectedAt,
      apiName: u.apiName,
    })),
  ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  return [...outages, ...events];
}
