import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { prisma } from '@open-gateway/database';
import { ApiService } from './api.service';
import { EndpointGovernanceService } from './endpoint-governance.service';
import { UpdateApiDto } from '../dto/update-api.dto';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { OAuthClientService } from '../../oauth-clients/services/oauth-client.service';
import type { ReconcileService } from './reconcile.service';

/**
 * OAS-03 against a REAL Postgres: the compare-and-set of `PATCH /apis/:id/endpoints`, jsonb equality
 * regardless of key order, tenant isolation, and `PATCH /apis/:id` never silently overwriting a
 * concurrent governance write — plus a CONTROL showing that the same race through an unguarded
 * read-modify-write does lose it (what the guard exists for). The gateway is a fake with no nodes; only
 * the database is real. Not part of `jest` (the file name does not match `.spec.ts`) because it needs a
 * THROWAWAY database — never the stack's. Run it:
 *
 *   docker run -d --rm --name og-probe-oas-gov-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55441:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55441/t?schema=public'
 *   (cd packages/database && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx prisma migrate deploy)
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --testRegex 'endpoint-governance\.db-spec\.ts$' --runInBand)
 *   docker rm -f og-probe-oas-gov-pg
 */

jest.setTimeout(60_000);

const INDEX = [
  { key: 'listOrders', method: 'GET', path: '/orders', operationId: 'listOrders', summary: null, tags: ['orders'], deprecated: false, securitySchemes: [] },
  { key: 'getOrder', method: 'GET', path: '/orders/{id}', operationId: 'getOrder', summary: null, tags: ['orders'], deprecated: false, securitySchemes: [] },
];

const tyk = { upsertOasApi: jest.fn().mockResolvedValue([]), getOasApiFromNode: jest.fn() };
const newApiService = () =>
  new ApiService(
    tyk as unknown as TykClientService,
    { findByApi: jest.fn().mockResolvedValue([]) } as unknown as OAuthClientService,
    {} as ReconcileService,
  );

/** Holds every compare-and-set until `n` callers have arrived, so they provably all read the same config first. */
function barrierOn(service: ApiService, n: number): void {
  const original = service.compareAndSetConfig.bind(service);
  let waiting: (() => void)[] = [];
  service.compareAndSetConfig = async (...args) => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) {
        waiting.forEach((release) => {
          release();
        });
        waiting = [];
      }
    });
    return original(...args);
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const configOf = async (id: string) =>
  (await prisma.apiDefinition.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>;
const setConfigRaw = (id: string, json: string) =>
  prisma.$executeRawUnsafe(`UPDATE api_definitions SET config = $1::jsonb WHERE id = $2`, json, id);

describe('endpoint governance on a real Postgres', () => {
  const tenants: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let apiA: string;
  const apis = newApiService();
  const governance = new EndpointGovernanceService(apis);

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const run = randomUUID().slice(0, 8);
    tenantA = (await prisma.tenant.create({ data: { name: 'A', slug: `gov-a-${run}`, tykOrgId: `gov-a-${run}` } })).id;
    tenantB = (await prisma.tenant.create({ data: { name: 'B', slug: `gov-b-${run}`, tykOrgId: `gov-b-${run}` } })).id;
    tenants.push(tenantA, tenantB);
    apiA = (
      await prisma.apiDefinition.create({
        data: { tenantId: tenantA, name: 'Orders', slug: 'orders', proxyUrl: 'http://orders:4000', listenPath: '/orders/', authType: 'NONE', config: { timeoutSeconds: 5 } },
      })
    ).id;
    await prisma.apiSpec.create({
      data: { tenantId: tenantA, apiDefId: apiA, versionNo: 1, contentHash: 'h', format: 'json', openapiVersion: '3.0.3', sourceText: '{}', endpointIndex: INDEX, endpointCount: 2 },
    });
  });

  afterAll(async () => {
    await settle(); // let background syncs finish their own row write
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } }); // cascades to APIs and specs
    await prisma.$disconnect();
  });

  it('two writers with the SAME revision: exactly one wins, the other gets 409, nothing is merged or lost', async () => {
    const racing = newApiService();
    barrierOn(racing, 2);
    const service = new EndpointGovernanceService(racing);
    const { revision } = await service.list(tenantA, apiA);

    const results = await Promise.allSettled([
      service.update(tenantA, apiA, { expectedRevision: revision, keys: ['listOrders'], set: { enabled: false } }),
      service.update(tenantA, apiA, { expectedRevision: revision, keys: ['getOrder'], set: { auth: 'public' } }),
    ]);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toBeInstanceOf(ConflictException);
    expect((lost[0]?.reason as ConflictException).getResponse()).toMatchObject({ error: 'ENDPOINT_REVISION_STALE' });

    const stored = await configOf(apiA);
    expect(Object.keys(stored.endpoints as object)).toHaveLength(1);
    expect(stored.timeoutSeconds).toBe(5);
    await settle();
  });

  it('a stale revision is refused with 409 before any write', async () => {
    const before = await prisma.apiDefinition.findUniqueOrThrow({ where: { id: apiA } });
    await expect(governance.update(tenantA, apiA, { expectedRevision: '0'.repeat(64), dropOrphans: true })).rejects.toBeInstanceOf(ConflictException);
    expect((await prisma.apiDefinition.findUniqueOrThrow({ where: { id: apiA } })).updatedAt).toEqual(before.updatedAt);
  });

  it('jsonb equality ignores key order: a config stored with its keys in another order still matches', async () => {
    await setConfigRaw(apiA, '{"zeta": 1, "timeoutSeconds": 5}');
    const reordered = { timeoutSeconds: 5, zeta: 1 };
    await expect(apis.compareAndSetConfig(apiA, tenantA, reordered, { timeoutSeconds: 5, zeta: 1, restrictToSpec: true })).resolves.toBe(true);
    await expect(apis.compareAndSetConfig(apiA, tenantA, reordered, { timeoutSeconds: 5 })).resolves.toBe(false); // now stale
    await settle();
  });

  it("tenant isolation: tenant B cannot read, write or compare-and-set tenant A's API", async () => {
    const { revision } = await governance.list(tenantA, apiA);
    const before = await prisma.apiDefinition.findUniqueOrThrow({ where: { id: apiA } });
    await expect(governance.list(tenantB, apiA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(governance.update(tenantB, apiA, { expectedRevision: revision, dropOrphans: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(apis.compareAndSetConfig(apiA, tenantB, before.config, {})).resolves.toBe(false);
    expect((await prisma.apiDefinition.findUniqueOrThrow({ where: { id: apiA } })).config).toEqual(before.config);
  });

  it('PATCH /apis/:id keeps endpoint governance (section merge)', async () => {
    const { revision } = await governance.list(tenantA, apiA);
    await governance.update(tenantA, apiA, { expectedRevision: revision, keys: ['getOrder'], set: { enabled: false } });
    await settle();
    await apis.update(apiA, plainToInstance(UpdateApiDto, { config: { timeoutSeconds: 9 } }), tenantA);
    await settle();
    expect(await configOf(apiA)).toMatchObject({ timeoutSeconds: 9, endpoints: { getOrder: { enabled: false } } });
  });

  /** A governance write landing after `run` has read the row and just before it writes. */
  async function raceGovernanceInto(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    await setConfigRaw(apiA, '{"timeoutSeconds": 5}');
    const { revision } = await governance.list(tenantA, apiA);
    const spy = jest.spyOn(prisma.apiDefinition, 'updateMany');
    const original = spy.getMockImplementation();
    let injected = false;
    spy.mockImplementation((async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        spy.mockRestore();
        await governance.update(tenantA, apiA, { expectedRevision: revision, keys: ['listOrders'], set: { enabled: false } });
      }
      return (original ?? prisma.apiDefinition.updateMany).apply(prisma.apiDefinition, args as never);
    }) as never);
    await run();
    spy.mockRestore();
    await settle();
    expect(injected).toBe(true);
    return configOf(apiA);
  }

  it('PATCH /apis/:id racing a governance write: the governance write is NOT lost (compare-and-set, re-merge, retry)', async () => {
    const config = await raceGovernanceInto(() => apis.update(apiA, plainToInstance(UpdateApiDto, { config: { timeoutSeconds: 9 } }), tenantA));
    expect(config).toEqual({ timeoutSeconds: 9, endpoints: { listOrders: { enabled: false } } });
  });

  it('CONTROL: the same race through an UNGUARDED read-modify-write loses the governance write', async () => {
    const config = await raceGovernanceInto(async () => {
      const read = await configOf(apiA); // read first, like the pre-OAS-03 update()
      await prisma.apiDefinition.updateMany({ where: { id: apiA, tenantId: tenantA }, data: { syncStatus: 'PENDING' } }); // governance lands here
      await prisma.apiDefinition.update({ where: { id: apiA }, data: { config: { ...read, timeoutSeconds: 9 } } }); // blind overwrite
    });
    expect(config).toEqual({ timeoutSeconds: 9 }); // the governance change is gone — what the guard prevents
  });
});
