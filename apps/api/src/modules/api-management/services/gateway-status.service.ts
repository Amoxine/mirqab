import { Injectable } from '@nestjs/common';
import { ApiSyncStatus } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { NodeOutcome, TykGatewayHealth } from '../../tyk-integration/services/tyk-client.service';

/** The subset of `TykGatewayHealth` this API exposes — never `status`/`details`, Tyk-internal shapes. */
export interface GatewaySummary {
  reachable: boolean;
  version: string | null;
  latencyMs: number | null;
  redis: 'pass' | 'fail' | 'unknown';
  error: string | null;
}

const summarize = (health: TykGatewayHealth): GatewaySummary => ({
  reachable: health.reachable,
  version: health.version,
  latencyMs: health.latencyMs,
  redis: health.redis,
  error: health.error,
});

/** Response of `GET /gateway/status` (spec §5.2). Analytics readiness is served by `/analytics/health`. */
export interface GatewayStatus {
  gateway: GatewaySummary;
  apis: { total: number; synced: number; pending: number; failed: number };
  /** At most `FAILED_SYNCS_MAX` entries, most recently touched first. */
  failedSyncs: {
    id: string;
    name: string;
    slug: string;
    syncError: string | null;
    lastSyncedAt: Date | null;
  }[];
}

const FAILED_SYNCS_MAX = 20;

@Injectable()
export class GatewayStatusService {
  constructor(private readonly tykClient: TykClientService) {}

  async getStatus(tenantId: string): Promise<GatewayStatus> {
    // gatewayHealth() never throws, so an unreachable gateway still yields a full 200 response.
    const [health, counts, failedSyncs] = await Promise.all([
      this.tykClient.gatewayHealth(),
      prisma.apiDefinition.groupBy({
        by: ['syncStatus'],
        where: { tenantId },
        _count: { _all: true },
      }),
      prisma.apiDefinition.findMany({
        where: { tenantId, syncStatus: ApiSyncStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
        take: FAILED_SYNCS_MAX,
        select: { id: true, name: true, slug: true, syncError: true, lastSyncedAt: true },
      }),
    ]);

    const countOf = (status: ApiSyncStatus): number =>
      counts.find((row) => row.syncStatus === status)?._count._all ?? 0;
    const synced = countOf(ApiSyncStatus.SYNCED);
    const pending = countOf(ApiSyncStatus.PENDING);
    const failed = countOf(ApiSyncStatus.FAILED);

    return {
      gateway: summarize(health),
      apis: { total: synced + pending + failed, synced, pending, failed },
      failedSyncs,
    };
  }

  /**
   * `GET /gateway/nodes/health` (WP14): read-only `/hello` for every configured node, trimmed to the
   * same shape `GET /gateway/status` already exposes — never Tyk's raw `status`/`details` fields.
   */
  async getNodeHealth(): Promise<{ nodeUrl: string; health: GatewaySummary }[]> {
    return (await this.tykClient.nodeHealth()).map(({ nodeUrl, health }) => ({
      nodeUrl,
      health: summarize(health),
    }));
  }

  /** `POST /gateway/reload` (WP14): the one platform-wide action a tenant admin has. */
  async reloadAll(): Promise<NodeOutcome<{ latencyMs: number }>[]> {
    return this.tykClient.reloadAllNodes();
  }
}
