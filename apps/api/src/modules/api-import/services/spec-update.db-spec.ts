import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { randomUUID } from 'node:crypto';
import { Prisma, prisma } from '@open-gateway/database';
import { ApiImportService } from './api-import.service';
import { ApiSpecService } from './api-spec.service';
import { buildEndpointIndex, contentHashOf } from './oas-endpoints';
import { SpectralLintService } from './spectral-lint.service';
import { SpecUpdateService } from './spec-update.service';
import type { ApiService } from '../../api-management/services/api.service';
import * as Parsers from '@stoplight/spectral-parsers';

/**
 * OAS-04 against a REAL Postgres: the version compare-and-set, its unique-index backstop, the config
 * guard's rollback and tenant isolation. Not part of `jest` (the file name does not match `.spec.ts`)
 * because it needs a THROWAWAY database — never the stack's. Run it:
 *
 *   docker run -d --rm --name og-probe-oas-specupdate-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55439:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55439/t?schema=public'
 *   (cd packages/database && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx prisma migrate deploy)
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --testRegex 'spec-update\.db-spec\.ts$')
 *   docker rm -f og-probe-oas-specupdate-pg
 */

const doc = (title: string, ops: string[]): string =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title, version: '1.0.0' },
    servers: [{ url: 'https://backend.example.com' }],
    paths: Object.fromEntries(ops.map((id) => [`/${id}`, { get: { operationId: id, responses: { 200: { description: 'ok' } } } }])),
  });

const V1 = doc('Orders', ['listOrders', 'createOrder']);

describe('SpecUpdateService on a real Postgres', () => {
  const syncNow = jest.fn().mockResolvedValue({});
  const service = new SpecUpdateService(
    new ApiImportService(new SpectralLintService(), {} as ApiService, new ApiSpecService()),
    { syncNow } as unknown as ApiService,
  );
  const tenants: string[] = [];

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } }); // cascades to APIs and specs
    await prisma.$disconnect();
  });

  /** A tenant with one API whose spec v1 is `V1`. */
  async function seed(
    config: Prisma.InputJsonValue | typeof Prisma.DbNull = {},
    withSpec = true,
  ): Promise<{ tenantId: string; apiId: string }> {
    const tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: 't', slug: `t-${tenantId}`, tykOrgId: `og-${tenantId}` } });
    const api = await prisma.apiDefinition.create({
      data: { tenantId, name: 'Orders', slug: 'orders', proxyUrl: 'https://backend.example.com', listenPath: '/orders/', config, syncStatus: 'SYNCED' },
    });
    if (!withSpec) return { tenantId, apiId: api.id };
    await prisma.apiSpec.create({
      data: {
        tenantId,
        apiDefId: api.id,
        versionNo: 1,
        contentHash: contentHashOf(V1),
        format: 'json',
        openapiVersion: '3.0.3',
        sourceText: V1,
        endpointIndex: buildEndpointIndex(Parsers.parseYaml(V1).data).endpoints as unknown as Prisma.InputJsonValue,
        endpointCount: 2,
      },
    });
    return { tenantId, apiId: api.id };
  }

  const versions = async (apiDefId: string): Promise<number[]> =>
    (await prisma.apiSpec.findMany({ where: { apiDefId }, select: { versionNo: true }, orderBy: { versionNo: 'asc' } })).map((r) => r.versionNo);
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'applied',
      (e: unknown) => {
        const body = typeof (e as { getResponse?: unknown }).getResponse === 'function' ? ((e as { getResponse: () => { error?: string } }).getResponse()) : {};
        return `${String((e as { getStatus?: () => number }).getStatus?.() ?? 500)} ${body.error ?? String(e)}`;
      },
    );

  it('applies v2, keeps config byte-for-byte, marks PENDING', async () => {
    const config = { endpoints: { listOrders: { auth: 'public' } }, cache: { enabled: false } };
    const { tenantId, apiId } = await seed(config);

    const result = await service.update(doc('Orders', ['listOrders', 'getOrder']), tenantId, apiId, {
      dryRun: false,
      expectedVersion: 1,
      acknowledgeRemoved: false,
    });

    expect(result).toMatchObject({ applied: true, versionNo: 2 });
    expect(await versions(apiId)).toEqual([1, 2]);
    const row = await prisma.apiDefinition.findUniqueOrThrow({ where: { id: apiId }, select: { config: true, syncStatus: true } });
    expect(row).toEqual({ config, syncStatus: 'PENDING' });
  });

  it('expectedVersion=0 gives a hand-created API its first spec; a second 0 is stale', async () => {
    const { tenantId, apiId } = await seed({}, false);
    const first = doc('Orders', ['a', 'b']);

    await expect(service.update(first, tenantId, apiId, { dryRun: false, expectedVersion: 0, acknowledgeRemoved: false })).resolves.toMatchObject({
      applied: true,
      versionNo: 1,
    });
    expect(await versions(apiId)).toEqual([1]);
    expect(await outcome(service.update(doc('Orders', ['c']), tenantId, apiId, { dryRun: false, expectedVersion: 0, acknowledgeRemoved: false }))).toBe(
      '409 SPEC_VERSION_STALE',
    );
  });

  it('works on an API whose config is NULL', async () => {
    const { tenantId, apiId } = await seed(Prisma.DbNull);

    await expect(
      service.update(doc('Orders', ['a']), tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false }),
    ).resolves.toMatchObject({ applied: true, versionNo: 2 });
  });

  it('two concurrent uploads on the same expectedVersion: exactly one wins, the other is 409', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 10; round += 1) {
      const { tenantId, apiId } = await seed();
      const results = await Promise.all(
        ['x', 'y'].map((op) =>
          outcome(service.update(doc('Orders', [op]), tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false })),
        ),
      );
      results.forEach((r) => seen.add(r));
      expect(results.filter((r) => r === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r === '409 SPEC_VERSION_STALE')).toHaveLength(1);
      expect(await versions(apiId)).toEqual([1, 2]);
    }
    expect([...seen].some((r) => r.startsWith('500'))).toBe(false);
  });

  it('the backstop: a duplicate (api_def_id, version_no) is a P2002 on this schema, which the service maps to 409', async () => {
    const { tenantId, apiId } = await seed();
    const dup = await prisma.apiSpec
      .create({
        data: { tenantId, apiDefId: apiId, versionNo: 1, contentHash: 'x', format: 'json', openapiVersion: '3.0.3', sourceText: '{}', endpointIndex: [], endpointCount: 0 },
      })
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((dup as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

    // Force the insert to collide AFTER the in-transaction version check passed: a concurrent writer
    // commits v2 between the check and the insert.
    const realCreate = prisma.apiSpec.create.bind(prisma.apiSpec);
    let raced = false;
    const original = prisma.$transaction.bind(prisma);
    const txSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      original(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== 'apiSpec') return Reflect.get(target, prop, receiver) as unknown;
            return {
              findFirst: tx.apiSpec.findFirst.bind(tx.apiSpec),
              create: async (args: Prisma.ApiSpecCreateArgs) => {
                if (!raced) {
                  raced = true;
                  await realCreate({ data: { ...args.data, contentHash: 'concurrent', sourceText: '{}' } as Prisma.ApiSpecUncheckedCreateInput });
                }
                return tx.apiSpec.create(args);
              },
            };
          },
        });
        return fn(proxy);
      })) as unknown as typeof prisma.$transaction);

    try {
      expect(await outcome(service.update(doc('Orders', ['z']), tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false }))).toBe(
        '409 SPEC_VERSION_STALE',
      );
    } finally {
      txSpy.mockRestore();
    }
    expect(raced).toBe(true);
    const rows = await prisma.apiSpec.findMany({ where: { apiDefId: apiId }, select: { versionNo: true, contentHash: true }, orderBy: { versionNo: 'asc' } });
    expect(rows.map((r) => [r.versionNo, r.contentHash === 'concurrent'])).toEqual([[1, false], [2, true]]);
  });

  it('a config change during the upload rolls the new version back (409 SPEC_GOVERNANCE_CHANGED)', async () => {
    const { tenantId, apiId } = await seed({ endpoints: {} });
    const original = prisma.$transaction.bind(prisma);
    const txSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      prisma.apiDefinition
        .update({ where: { id: apiId }, data: { config: { endpoints: { createOrder: { enabled: false } } } } })
        .then(() => original(fn))) as unknown as typeof prisma.$transaction);

    try {
      expect(await outcome(service.update(doc('Orders', ['listOrders']), tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false }))).toBe(
        '409 SPEC_GOVERNANCE_CHANGED',
      );
    } finally {
      txSpy.mockRestore();
    }
    expect(await versions(apiId)).toEqual([1]);
  });

  it('another tenant’s API is 404 and nothing of it changes', async () => {
    const a = await seed();
    const b = await seed();

    expect(await outcome(service.update(doc('Orders', ['q']), b.tenantId, a.apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false }))).toBe(
      '404 Not Found',
    );
    expect(await outcome(service.update(doc('Orders', ['q']), b.tenantId, a.apiId, { dryRun: true, expectedVersion: 1, acknowledgeRemoved: false }))).toBe(
      '404 Not Found',
    );
    expect(await versions(a.apiId)).toEqual([1]);
    expect((await prisma.apiDefinition.findUniqueOrThrow({ where: { id: a.apiId } })).syncStatus).toBe('SYNCED');
  });
});
