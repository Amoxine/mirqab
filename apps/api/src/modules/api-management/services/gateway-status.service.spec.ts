import 'reflect-metadata';
import { prisma } from '@open-gateway/database';
import type { NodeOutcome, TykClientService, TykGatewayHealth } from '../../tyk-integration/services/tyk-client.service';
import { GatewayStatusService } from './gateway-status.service';

jest.mock('@open-gateway/database', () => ({
  prisma: { apiDefinition: { groupBy: jest.fn(), findMany: jest.fn() } },
}));

const db = prisma.apiDefinition as unknown as Record<'groupBy' | 'findMany', jest.Mock>;

const up: TykGatewayHealth = {
  reachable: true,
  status: 'pass',
  version: '5.15.0',
  redis: 'pass',
  latencyMs: 12,
  details: { redis: { status: 'pass' } },
  error: null,
};

const down: TykGatewayHealth = {
  reachable: false,
  status: null,
  version: null,
  redis: 'unknown',
  latencyMs: null,
  details: null,
  error: 'Gateway unreachable',
};

function makeService(
  health: TykGatewayHealth,
  overrides: Partial<{ nodeHealth: jest.Mock; reloadAllNodes: jest.Mock }> = {},
): GatewayStatusService {
  const tyk = {
    gatewayHealth: jest.fn().mockResolvedValue(health),
    nodeHealth: overrides.nodeHealth ?? jest.fn().mockResolvedValue([]),
    reloadAllNodes: overrides.reloadAllNodes ?? jest.fn().mockResolvedValue([]),
  };
  return new GatewayStatusService(tyk as unknown as TykClientService);
}

describe('GatewayStatusService.getStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates sync counts, scopes every query to the tenant and lists failed syncs', async () => {
    const failed = { id: 'a3', name: 'Bad', slug: 'bad', syncError: 'boom', lastSyncedAt: null };
    db.groupBy.mockResolvedValue([
      { syncStatus: 'SYNCED', _count: { _all: 4 } },
      { syncStatus: 'FAILED', _count: { _all: 1 } },
    ]);
    db.findMany.mockResolvedValue([failed]);

    const status = await makeService(up).getStatus('tenant-1');

    expect(status.apis).toEqual({ total: 5, synced: 4, pending: 0, failed: 1 });
    expect(status.failedSyncs).toEqual([failed]);
    expect(status.gateway).toEqual({ reachable: true, version: '5.15.0', latencyMs: 12, redis: 'pass', error: null });
    expect(db.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1' } }));
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1', syncStatus: 'FAILED' }, take: 20 }),
    );
  });

  it('reports zeroes for a tenant with no APIs', async () => {
    db.groupBy.mockResolvedValue([]);
    db.findMany.mockResolvedValue([]);

    const status = await makeService(up).getStatus('tenant-1');

    expect(status.apis).toEqual({ total: 0, synced: 0, pending: 0, failed: 0 });
    expect(status.failedSyncs).toEqual([]);
  });

  it('still resolves with API data when the gateway is unreachable', async () => {
    db.groupBy.mockResolvedValue([{ syncStatus: 'PENDING', _count: { _all: 2 } }]);
    db.findMany.mockResolvedValue([]);

    const status = await makeService(down).getStatus('tenant-1');

    expect(status.gateway).toEqual({
      reachable: false,
      version: null,
      latencyMs: null,
      redis: 'unknown',
      error: 'Gateway unreachable',
    });
    expect(status.apis).toEqual({ total: 2, synced: 0, pending: 2, failed: 0 });
  });
});

describe('GatewayStatusService — WP14 (node health, reload)', () => {
  it('getNodeHealth trims each node to the same shape GET /gateway/status already exposes', async () => {
    const nodeHealth = jest.fn().mockResolvedValue([{ nodeUrl: 'http://n1:8081/tyk', health: up }]);

    const result = await makeService(up, { nodeHealth }).getNodeHealth();

    expect(result).toEqual([
      {
        nodeUrl: 'http://n1:8081/tyk',
        health: { reachable: true, version: '5.15.0', latencyMs: 12, redis: 'pass', error: null },
      },
    ]);
    // Never Tyk's raw fields — those aren't this API's shape to expose.
    expect(result[0].health).not.toHaveProperty('status');
    expect(result[0].health).not.toHaveProperty('details');
    expect(nodeHealth).toHaveBeenCalledWith();
  });

  it('reloadAll passes through TykClientService.reloadAllNodes() unchanged', async () => {
    const outcome: NodeOutcome<{ latencyMs: number }>[] = [
      { nodeUrl: 'http://n1:8081/tyk', ok: true, data: { latencyMs: 910 } },
    ];
    const reloadAllNodes = jest.fn().mockResolvedValue(outcome);

    const result = await makeService(up, { reloadAllNodes }).reloadAll();

    expect(result).toEqual(outcome);
    expect(reloadAllNodes).toHaveBeenCalledWith();
  });
});
