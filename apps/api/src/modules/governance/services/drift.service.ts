import { Injectable } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { ApiService } from '../../api-management/services/api.service';
import type { SyncState } from '../../api-management/services/reconcile.service';

export interface ApiDriftReport {
  apiDefId: string;
  name: string;
  inSync: boolean;
  differences: string[];
  perNode: SyncState['nodes'];
}

export interface DriftReport {
  apis: ApiDriftReport[];
  summary: { totalApis: number; inSyncCount: number; driftedCount: number };
}

/**
 * `GET /governance/drift` (WP25) — the tenant-wide view of WP13a's per-API drift, for an operator
 * deciding whether `POST /apis/:id/sync` (push Postgres out) or `POST /governance/apis/:id/adopt`
 * (pull a node in) is the right call for a given API.
 *
 * Reuses `ApiService.drift()` per API — the SAME hash/diff machinery `GET /apis/:id/drift` already
 * exercises, recomputed on demand rather than read from the (up to 60s stale) `syncState` column, so
 * this report never contradicts a `drift()` call made a second later. No second diff implementation:
 * this service is a loop and an aggregate, nothing else.
 *
 * Sequential, not `Promise.all`: `reconcileAll()`'s own scheduled sweep loops one definition at a
 * time for the same reason (`reconcile.service.ts`) — each check is itself a fan-out over every
 * gateway node, and firing all of a tenant's APIs' checks at once multiplies that by the API count
 * against the same admin API and the same per-node circuit breakers.
 */
@Injectable()
export class GovernanceDriftService {
  constructor(private readonly apiService: ApiService) {}

  async report(tenantId: string): Promise<DriftReport> {
    // Never-synced APIs (no tykApiId) are excluded up front, matching reconcileAll(): there is
    // nothing on any node to compare, so `drift()` would only ever report the same fixed sentinel.
    const candidates = await prisma.apiDefinition.findMany({
      where: { tenantId, tykApiId: { not: null } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });

    const apis: ApiDriftReport[] = [];
    for (const { id, name } of candidates) {
      const { inSync, differences, perNode } = await this.apiService.drift(id, tenantId);
      apis.push({ apiDefId: id, name, inSync, differences, perNode });
    }

    const inSyncCount = apis.filter((a) => a.inSync).length;
    return {
      apis,
      summary: { totalApis: apis.length, inSyncCount, driftedCount: apis.length - inSyncCount },
    };
  }
}
