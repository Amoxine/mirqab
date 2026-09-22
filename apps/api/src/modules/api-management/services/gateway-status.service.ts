import { Injectable } from '@nestjs/common';
import { ApiSyncStatus } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';

/** Response of `GET /gateway/status` (spec §5.2). Analytics readiness is served by `/analytics/health`. */
export interface GatewayStatus {
  gateway: {
    reachable: boolean;
    version: string | null;
    latencyMs: number | null;
    redis: 'pass' | 'fail' | 'unknown';
    error: string | null;
  };
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
      gateway: {
        reachable: health.reachable,
        version: health.version,
        latencyMs: health.latencyMs,
        redis: health.redis,
        error: health.error,
      },
      apis: { total: synced + pending + failed, synced, pending, failed },
      failedSyncs,
    };
  }
}
