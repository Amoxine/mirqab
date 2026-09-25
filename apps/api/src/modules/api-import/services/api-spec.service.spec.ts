import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { ApiSpecService } from './api-spec.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    apiDefinition: { findMany: jest.fn() },
    apiSpec: { findFirst: jest.fn() },
  },
}));

const db = prisma as unknown as {
  apiDefinition: { findMany: jest.Mock };
  apiSpec: { findFirst: jest.Mock };
};

/** First argument of a mock's first call. */
const firstArg = (fn: jest.Mock): unknown => (fn.mock.calls as unknown[][])[0]?.[0];

const TENANT = 'tenant-1';
const API = '11111111-1111-1111-1111-111111111111';
const summary = {
  versionNo: 3,
  contentHash: 'h'.repeat(64),
  format: 'yaml',
  openapiVersion: '3.0.3',
  endpointCount: 2,
  createdAt: new Date(0),
};

describe('ApiSpecService', () => {
  let service: ApiSpecService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new ApiSpecService();
  });

  describe('latest', () => {
    it('reads the NEWEST version of this tenant\'s API, source text included', async () => {
      db.apiSpec.findFirst.mockResolvedValue({ ...summary, sourceText: 'openapi: 3.0.3\n' });

      const doc = await service.latest(TENANT, API);

      expect(doc).toMatchObject({ versionNo: 3, sourceText: 'openapi: 3.0.3\n' });
      const args = firstArg(db.apiSpec.findFirst) as { where: unknown; orderBy: unknown; select: Record<string, boolean> };
      expect(args.where).toEqual({ tenantId: TENANT, apiDefId: API });
      expect(args.orderBy).toEqual({ versionNo: 'desc' });
      expect(args.select.sourceText).toBe(true);
    });

    it('answers 404 when nothing is stored — which is also what another tenant\'s API looks like', async () => {
      db.apiSpec.findFirst.mockResolvedValue(null);

      await expect(service.latest(TENANT, API)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('latestEndpoints', () => {
    it('returns the index without the source text, tenant-scoped', async () => {
      const endpoints = [{ key: 'listOrders', method: 'GET', path: '/orders' }];
      db.apiSpec.findFirst.mockResolvedValue({ ...summary, endpointIndex: endpoints });

      const result = await service.latestEndpoints(TENANT, API);

      expect(result).toEqual({ ...summary, endpoints });
      expect(result).not.toHaveProperty('sourceText');
      expect(result).not.toHaveProperty('endpointIndex');
      const args = firstArg(db.apiSpec.findFirst) as { where: unknown; select: Record<string, boolean> };
      expect(args.where).toEqual({ tenantId: TENANT, apiDefId: API });
      expect(args.select.sourceText).toBeUndefined(); // never loads the up-to-5 MB text for a list
    });

    it('tolerates a malformed stored index rather than crashing the list', async () => {
      db.apiSpec.findFirst.mockResolvedValue({ ...summary, endpointIndex: { not: 'an array' } });

      await expect(service.latestEndpoints(TENANT, API)).resolves.toMatchObject({ endpoints: [] });
    });

    it('answers 404 when nothing is stored', async () => {
      db.apiSpec.findFirst.mockResolvedValue(null);

      await expect(service.latestEndpoints(TENANT, API)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('conflicts', () => {
    it('only looks at THIS tenant\'s APIs and says which of slug / listen path collides', async () => {
      db.apiDefinition.findMany.mockResolvedValue([{ slug: 'orders', listenPath: '/other/' }]);

      await expect(service.conflicts(TENANT, 'orders', '/orders/')).resolves.toEqual({ slug: true, listenPath: false });

      const args = firstArg(db.apiDefinition.findMany) as { where: { tenantId: string; OR: unknown[] } };
      expect(args.where.tenantId).toBe(TENANT);
      expect(args.where.OR).toEqual([{ slug: 'orders' }, { listenPath: '/orders/' }]);
    });

    it('reports no conflict when nothing matches', async () => {
      db.apiDefinition.findMany.mockResolvedValue([]);

      await expect(service.conflicts(TENANT, 'orders', '/orders/')).resolves.toEqual({ slug: false, listenPath: false });
    });

    it('can report both at once', async () => {
      db.apiDefinition.findMany.mockResolvedValue([
        { slug: 'orders', listenPath: '/x/' },
        { slug: 'y', listenPath: '/orders/' },
      ]);

      await expect(service.conflicts(TENANT, 'orders', '/orders/')).resolves.toEqual({ slug: true, listenPath: true });
    });
  });
});
