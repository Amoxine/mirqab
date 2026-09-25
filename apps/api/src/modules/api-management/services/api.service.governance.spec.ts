import 'reflect-metadata';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { OAuthClientService } from '../../oauth-clients/services/oauth-client.service';
import type { ReconcileService } from './reconcile.service';
import { UpdateApiDto } from '../dto/update-api.dto';
import { ApiService } from './api.service';
import { operationsOf } from './endpoint-operations';

/** OAS-03 additions to ApiService: spec refs on sync/debug, per-node read-back, compare-and-set, cache guard. */

jest.mock('@open-gateway/database', () => ({
  prisma: {
    tenant: { findUniqueOrThrow: jest.fn() },
    apiDefinition: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    apiSpec: { findFirst: jest.fn() },
  },
}));

type Fn = jest.Mock;
const db = prisma.apiDefinition as unknown as Record<'findFirst' | 'findUnique' | 'findMany' | 'update' | 'updateMany', Fn>;
const specs = prisma.apiSpec as unknown as Record<'findFirst', Fn>;
const tenants = prisma.tenant as unknown as Record<'findUniqueOrThrow', Fn>;

const TENANT = 'tenant-1';
const ID = '11111111-1111-1111-1111-111111111111';
const INDEX = [
  { key: 'listOrders', method: 'GET', path: '/orders', tags: [] },
  { key: 'getOrder', method: 'GET', path: '/orders/{id}', tags: [] },
];

function row(config: unknown) {
  return {
    id: ID,
    tenantId: TENANT,
    name: 'Orders',
    slug: 'orders',
    tykApiId: 'og-1',
    proxyUrl: 'http://orders:4000',
    listenPath: '/orders/',
    authType: 'NONE',
    status: 'ACTIVE',
    config,
    oasDocument: null,
    syncStatus: 'PENDING',
    syncError: null,
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    parentApiId: null,
    versionName: null,
    retiredAt: null,
    defFormat: 'OAS',
    protocol: 'HTTP',
    webhooksEnabled: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _count: { apiKeys: 0 },
  };
}

const NODES = ['http://tyk-1/tyk', 'http://tyk-2/tyk'];

function setup() {
  const tyk = {
    upsertOasApi: jest.fn().mockResolvedValue(NODES.map((nodeUrl) => ({ nodeUrl, ok: true }))),
    getOasApiFromNode: jest.fn(),
    debug: jest.fn().mockResolvedValue({}),
  };
  const service = new ApiService(
    tyk as unknown as TykClientService,
    { findByApi: jest.fn().mockResolvedValue([]) } as unknown as OAuthClientService,
    {} as ReconcileService,
  );
  return { tyk, service };
}

/** What the last push sent, and a node that echoes it back (plus a Tyk-style injected default). */
const pushed = (tyk: ReturnType<typeof setup>['tyk']) => (tyk.upsertOasApi.mock.calls[0] as Record<string, unknown>[])[0];
const echo = (tyk: ReturnType<typeof setup>['tyk']) => () => {
  const doc = JSON.parse(JSON.stringify(pushed(tyk))) as Record<string, unknown>;
  for (const op of Object.values(operationsOf(doc))) (op as Record<string, unknown>).injectedDefault = {};
  return Promise.resolve(doc);
};
const lastUpdate = () => (db.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  tenants.findUniqueOrThrow.mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' });
  db.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...row({}), ...data }));
  specs.findFirst.mockResolvedValue({ endpointIndex: INDEX });
  // WP16: the OAS sync looks up active child versions.
  db.findMany.mockResolvedValue([]);
});

describe('ApiService sync with endpoint governance (OAS-03)', () => {
  it('does not load the spec, nor read back, for an ungoverned API', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ timeoutSeconds: 5 }));
    await service.syncNow(ID, TENANT);
    expect(specs.findFirst).not.toHaveBeenCalled();
    expect(tyk.getOasApiFromNode).not.toHaveBeenCalled();
    expect(lastUpdate().syncStatus).toBe('SYNCED');
  });

  it('loads the tenant-scoped index, pushes real operations and reads every node back', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { getOrder: { enabled: false } } }));
    tyk.getOasApiFromNode.mockImplementation(echo(tyk));
    await service.syncNow(ID, TENANT);

    expect(specs.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, apiDefId: ID }, select: { endpointIndex: true } }),
    );
    expect(operationsOf(pushed(tyk)).og_ep1).toEqual({ block: { enabled: true } });
    expect(tyk.getOasApiFromNode.mock.calls.map((c: unknown[]) => c[1])).toEqual(NODES);
    expect(lastUpdate().syncStatus).toBe('SYNCED');
  });

  it('marks the row FAILED when one node does not report the governed operations as sent', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { getOrder: { enabled: false } } }));
    tyk.getOasApiFromNode.mockImplementation(async (_id: string, nodeUrl: string) => {
      const doc = await echo(tyk)();
      if (nodeUrl === NODES[1]) (operationsOf(doc).og_ep1 as Record<string, unknown>).block = { enabled: false };
      return doc;
    });
    await service.syncNow(ID, TENANT);
    expect(lastUpdate().syncStatus).toBe('FAILED');
    expect(lastUpdate().syncError).toMatch(/1 of 2 .*report it as sent/);
  });

  it('marks the row FAILED when a node cannot be read back', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { getOrder: { enabled: false } } }));
    tyk.getOasApiFromNode.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:8080'));
    const detail = await service.syncNow(ID, TENANT);
    expect(detail.syncStatus).toBe('FAILED');
    expect(JSON.stringify(db.update.mock.calls)).not.toContain('10.0.0.5');
  });

  it('fails closed (no push) in allow-list mode when the stored spec has no endpoints', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ restrictToSpec: true }));
    specs.findFirst.mockResolvedValue({ endpointIndex: [] });
    await service.syncNow(ID, TENANT);
    expect(tyk.upsertOasApi).not.toHaveBeenCalled();
    expect(lastUpdate().syncStatus).toBe('FAILED');
    expect(lastUpdate().syncError).toMatch(/no endpoints/);
  });

  it('skips malformed index rows rather than trusting them', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ restrictToSpec: true }));
    specs.findFirst.mockResolvedValue({ endpointIndex: [null, 'x', { key: 1 }, ...INDEX] });
    tyk.getOasApiFromNode.mockImplementation(echo(tyk));
    await service.syncNow(ID, TENANT);
    expect(Object.keys(operationsOf(pushed(tyk)))).toEqual(expect.arrayContaining(['og_ep0', 'og_ep1']));
  });

  it('a debug request on a definition the mapper refuses answers 400, not 500', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { up: { enabled: false }, low: { enabled: false } } }));
    specs.findFirst.mockResolvedValue({ endpointIndex: [
      { key: 'up', method: 'GET', path: '/Admin' },
      { key: 'low', method: 'GET', path: '/admin' },
    ] });
    await expect(service.debugRequest(ID, TENANT, { method: 'GET', path: '/admin' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tyk.debug).not.toHaveBeenCalled();
  });

  it('debug requests render the same governed definition', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { getOrder: { enabled: false } } }));
    await service.debugRequest(ID, TENANT, { method: 'GET', path: '/orders/1' });
    const payload = (tyk.debug.mock.calls[0] as { oas: unknown }[])[0];
    expect(operationsOf(payload.oas).og_ep1).toEqual({ block: { enabled: true } });
  });
});

describe('ApiService background syncs are serialised per API (M3)', () => {
  it('two overlapping syncs leave the gateway on the NEWEST config, re-read inside the lock', async () => {
    const { tyk, service } = setup();
    let current = row({ timeoutSeconds: 1 });
    db.findFirst.mockImplementation(() => Promise.resolve(current));
    db.findUnique.mockImplementation(() => Promise.resolve(current));
    const landed: unknown[] = [];
    let first = true;
    tyk.upsertOasApi.mockImplementation(async (def: Record<string, unknown>) => {
      // The first push is slow; without serialisation the second one lands BEFORE it.
      const slow = first;
      first = false;
      await new Promise((resolve) => setTimeout(resolve, slow ? 50 : 0));
      landed.push((def['x-tyk-api-gateway'] as { upstream: { enforceTimeout?: unknown } }).upstream.enforceTimeout);
      return [];
    });
    const one = service.syncNow(ID, TENANT);
    await new Promise((resolve) => setImmediate(resolve));
    current = row({ timeoutSeconds: 2 });
    const two = service.syncNow(ID, TENANT);
    await Promise.all([one, two]);
    expect(landed.at(-1)).toEqual({ enabled: true, duration: '2s' });
    expect(landed).toHaveLength(2);
  });

  it('a sync handed a stale snapshot pushes the config stored now', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ timeoutSeconds: 1 }));
    db.findUnique.mockResolvedValue(row({ timeoutSeconds: 7 }));
    await service.syncNow(ID, TENANT);
    expect((pushed(tyk)['x-tyk-api-gateway'] as { upstream: unknown }).upstream).toMatchObject({ enforceTimeout: { duration: '7s' } });
  });

  it('a failed sync does not wedge the next one', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({}));
    tyk.upsertOasApi.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
    await service.syncNow(ID, TENANT);
    await service.syncNow(ID, TENANT);
    expect(tyk.upsertOasApi).toHaveBeenCalledTimes(2);
    expect(lastUpdate().syncStatus).toBe('SYNCED');
  });

  it('a mapper refusal (colliding endpoints) lands on the row as FAILED with its reason', async () => {
    const { tyk, service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { up: { enabled: false }, low: { enabled: false } } }));
    specs.findFirst.mockResolvedValue({ endpointIndex: [
      { key: 'up', method: 'GET', path: '/Admin' },
      { key: 'low', method: 'GET', path: '/admin' },
    ] });
    await service.syncNow(ID, TENANT);
    expect(tyk.upsertOasApi).not.toHaveBeenCalled();
    expect(lastUpdate().syncStatus).toBe('FAILED');
    expect(lastUpdate().syncError).toMatch(/route the same/);
  });
});

describe('ApiService.compareAndSetConfig', () => {
  it('writes only when config still equals what was read, tenant-scoped, and marks PENDING', async () => {
    const { tyk, service } = setup();
    db.updateMany.mockResolvedValue({ count: 1 });
    db.findFirst.mockResolvedValue(row({ endpoints: {} }));
    await expect(service.compareAndSetConfig(ID, TENANT, { a: 1 }, { b: 2 })).resolves.toBe(true);
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: ID, tenantId: TENANT, config: { equals: { a: 1 } } },
      data: { config: { b: 2 }, syncStatus: 'PENDING' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(tyk.upsertOasApi).toHaveBeenCalled();
  });

  it('reports a lost race and starts no sync', async () => {
    const { tyk, service } = setup();
    db.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.compareAndSetConfig(ID, TENANT, {}, { b: 2 })).resolves.toBe(false);
    expect(db.findFirst).not.toHaveBeenCalled();
    expect(tyk.upsertOasApi).not.toHaveBeenCalled();
  });

  it('matches a NULL config with AnyNull', async () => {
    const { service } = setup();
    db.updateMany.mockResolvedValue({ count: 0 });
    await service.compareAndSetConfig(ID, TENANT, null, {});
    expect((db.updateMany.mock.calls[0] as [{ where: { config: unknown } }])[0].where.config).toEqual({ equals: Prisma.AnyNull });
  });
});

describe('ApiService.update and per-endpoint cache', () => {
  const patch = (config: unknown) => plainToInstance(UpdateApiDto, { config });

  it('refuses an API-wide cache while an endpoint has its own', async () => {
    const { service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { listOrders: { cache: { timeoutSeconds: 5 } } } }));
    await expect(service.update(ID, patch({ cache: { timeoutSeconds: 30 } }), TENANT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows it when no endpoint caches, and keeps the governance through the section merge', async () => {
    const { service } = setup();
    db.findFirst.mockResolvedValue(row({ endpoints: { listOrders: { enabled: false } }, restrictToSpec: true }));
    db.updateMany.mockResolvedValue({ count: 1 });
    await service.update(ID, patch({ cache: { timeoutSeconds: 30 } }), TENANT);
    expect(manyCall(0).data.config).toMatchObject({
      endpoints: { listOrders: { enabled: false } },
      restrictToSpec: true,
      cache: { timeoutSeconds: 30 },
    });
  });
});

const manyCall = (n: number) =>
  (db.updateMany.mock.calls[n] as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];

describe('ApiService.update never silently overwrites a concurrent governance write', () => {
  const patch = (config: unknown) => plainToInstance(UpdateApiDto, { config });
  const governed = { timeoutSeconds: 5, endpoints: { getOrder: { enabled: false } } };

  it('writes config only where it still equals what was read', async () => {
    const { service } = setup();
    db.findFirst.mockResolvedValue(row({ timeoutSeconds: 5 }));
    db.updateMany.mockResolvedValue({ count: 1 });
    await service.update(ID, patch({ timeoutSeconds: 9 }), TENANT);
    expect(manyCall(0).where).toEqual({ id: ID, tenantId: TENANT, config: { equals: { timeoutSeconds: 5 } } });
    const plainWrites = db.update.mock.calls as [{ data: Record<string, unknown> }][];
    expect(plainWrites.some(([arg]) => 'config' in arg.data)).toBe(false);
  });

  it('a governance write landing between the read and the write is kept (re-read, re-merge, retry once)', async () => {
    const { service } = setup();
    db.findFirst
      .mockResolvedValueOnce(row({ timeoutSeconds: 5 })) // update() reads
      .mockResolvedValueOnce(row(governed)) // retry re-reads: PATCH /endpoints landed in between
      .mockResolvedValue(row({ ...governed, timeoutSeconds: 9 }));
    db.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await service.update(ID, patch({ timeoutSeconds: 9 }), TENANT);
    expect(manyCall(1).where.config).toEqual({ equals: governed });
    expect(manyCall(1).data.config).toEqual({ timeoutSeconds: 9, endpoints: { getOrder: { enabled: false } } });
  });

  it('answers 409 when it loses twice, never overwriting', async () => {
    const { service } = setup();
    db.findFirst.mockResolvedValue(row(governed));
    db.updateMany.mockResolvedValue({ count: 0 });
    const err = await service.update(ID, patch({ timeoutSeconds: 9 }), TENANT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ error: 'API_CONFIG_CHANGED' });
    expect(db.updateMany).toHaveBeenCalledTimes(2);
  });

  it('re-checks the cache conflict against the re-read config', async () => {
    const { service } = setup();
    db.findFirst
      .mockResolvedValueOnce(row({}))
      .mockResolvedValueOnce(row({ endpoints: { listOrders: { cache: { timeoutSeconds: 5 } } } }));
    db.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.update(ID, patch({ cache: { timeoutSeconds: 30 } }), TENANT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a protocol change on an API that governs endpoints (would bypass the TCP refusal)', async () => {
    const { service } = setup();
    db.findFirst.mockResolvedValue(row(governed));
    await expect(service.update(ID, plainToInstance(UpdateApiDto, { protocol: 'TCP', listenPort: 9000 }), TENANT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    db.findFirst.mockResolvedValue(row({}));
    db.update.mockResolvedValue(row({}));
    await expect(service.update(ID, plainToInstance(UpdateApiDto, { protocol: 'HTTP' }), TENANT)).resolves.toBeDefined();
  });

  it('leaves updates without config on the plain write', async () => {
    const { service } = setup();
    db.findFirst.mockResolvedValue(row(governed));
    await service.update(ID, plainToInstance(UpdateApiDto, { name: 'Renamed' }), TENANT);
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });
});
