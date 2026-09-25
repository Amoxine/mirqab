import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import type { ApiService } from './api.service';
import { EndpointGovernanceService } from './endpoint-governance.service';
import { governanceRevision, readGovernanceState } from './endpoint-governance';

jest.mock('@open-gateway/database', () => ({
  prisma: { apiDefinition: { findFirst: jest.fn() }, apiSpec: { findFirst: jest.fn() } },
}));

type Fn = jest.Mock;
const apis = prisma.apiDefinition as unknown as Record<'findFirst', Fn>;
const specs = prisma.apiSpec as unknown as Record<'findFirst', Fn>;

const TENANT = 'tenant-a';
const ID = '11111111-1111-1111-1111-111111111111';
const INDEX = [
  { key: 'listOrders', method: 'GET', path: '/orders', operationId: 'listOrders', summary: null, tags: ['orders'], deprecated: false, securitySchemes: [] },
  { key: 'createOrder', method: 'POST', path: '/orders', operationId: 'createOrder', summary: null, tags: ['orders'], deprecated: false, securitySchemes: [] },
];
const SPEC = { versionNo: 1, contentHash: 'h', format: 'json', openapiVersion: '3.0.3', endpointCount: 2, createdAt: new Date(0), endpointIndex: INDEX };

function api(config: unknown, overrides: Record<string, unknown> = {}) {
  return { config, syncStatus: 'SYNCED', syncError: null, defFormat: 'OAS', protocol: 'HTTP', ...overrides };
}
const revisionOf = (config: Record<string, unknown>, versionNo = 1) => governanceRevision(readGovernanceState(config), versionNo);

function setup(casResult = true) {
  const apiService = { compareAndSetConfig: jest.fn().mockResolvedValue(casResult) };
  return { apiService, service: new EndpointGovernanceService(apiService as unknown as ApiService) };
}

beforeEach(() => {
  jest.resetAllMocks();
  specs.findFirst.mockResolvedValue(SPEC);
});

describe('EndpointGovernanceService.list', () => {
  it('joins the index with governance, reports orphans, revision and every capability', async () => {
    const config = { timeoutSeconds: 5, endpoints: { listOrders: { enabled: false }, gone: { auth: 'public' } } };
    apis.findFirst.mockResolvedValue(api(config));
    const view = await setup().service.list(TENANT, ID);
    expect(view.endpoints.map((e) => [e.key, e.governance])).toEqual([
      ['listOrders', { enabled: false }],
      ['createOrder', null],
    ]);
    expect(view.endpoints[0]).toMatchObject({ operationId: 'listOrders', summary: null });
    expect(view.orphans).toEqual([{ key: 'gone', governance: { auth: 'public' } }]);
    expect(view.revision).toBe(revisionOf(config));
    expect(view.restrictToSpec).toBe(false);
    expect(view.capabilities.find((c) => c.control === 'rateLimit')?.status).toBe('enforced');
    expect(view).not.toHaveProperty('endpointIndex');
  });

  it('scopes BOTH queries to the tenant', async () => {
    apis.findFirst.mockResolvedValue(api({}));
    await setup().service.list(TENANT, ID);
    const whereOf = (fn: Fn) => (fn.mock.calls[0] as [{ where: unknown }])[0].where;
    expect(whereOf(apis.findFirst)).toEqual({ id: ID, tenantId: TENANT });
    expect(whereOf(specs.findFirst)).toEqual({ tenantId: TENANT, apiDefId: ID });
  });

  it('is 404 for another tenant\'s API and for an API without a spec', async () => {
    apis.findFirst.mockResolvedValue(null);
    await expect(setup().service.list('tenant-b', ID)).rejects.toBeInstanceOf(NotFoundException);
    apis.findFirst.mockResolvedValue(api({}));
    specs.findFirst.mockResolvedValue(null);
    await expect(setup().service.list(TENANT, ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EndpointGovernanceService.update', () => {
  it('writes the merged config by compare-and-set against the config it read, other sections untouched', async () => {
    const config = { timeoutSeconds: 5, cors: { enable: true } };
    apis.findFirst.mockResolvedValue(api(config));
    const { service, apiService } = setup();
    await service.update(TENANT, ID, { expectedRevision: revisionOf(config), keys: ['listOrders'], set: { enabled: false } });
    expect(apiService.compareAndSetConfig).toHaveBeenCalledWith(ID, TENANT, config, {
      timeoutSeconds: 5,
      cors: { enable: true },
      endpoints: { listOrders: { enabled: false } },
    });
  });

  it('removes the keys entirely when governance becomes empty', async () => {
    const config = { endpoints: { listOrders: { enabled: false } }, restrictToSpec: true };
    apis.findFirst.mockResolvedValue(api(config));
    const { service, apiService } = setup();
    await service.update(TENANT, ID, { expectedRevision: revisionOf(config), keys: ['listOrders'], set: { enabled: true }, restrictToSpec: false });
    expect((apiService.compareAndSetConfig.mock.calls[0] as unknown[])[3]).toEqual({});
  });

  it('answers 409 ENDPOINT_REVISION_STALE for a stale revision, writing nothing', async () => {
    apis.findFirst.mockResolvedValue(api({ endpoints: { listOrders: { enabled: false } } }));
    const { service, apiService } = setup();
    const err = await service.update(TENANT, ID, { expectedRevision: revisionOf({}), dropOrphans: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ error: 'ENDPOINT_REVISION_STALE' });
    expect(apiService.compareAndSetConfig).not.toHaveBeenCalled();
  });

  it('L11: a revision read against spec version 1 is stale once version 2 is the latest', async () => {
    apis.findFirst.mockResolvedValue(api({}));
    specs.findFirst.mockResolvedValue({ ...SPEC, versionNo: 2 });
    const { service, apiService } = setup();
    expect((await service.list(TENANT, ID)).revision).toBe(revisionOf({}, 2));
    await expect(service.update(TENANT, ID, { expectedRevision: revisionOf({}, 1), dropOrphans: true })).rejects.toBeInstanceOf(ConflictException);
    expect(apiService.compareAndSetConfig).not.toHaveBeenCalled();
  });

  it('answers 409 when the compare-and-set loses the race', async () => {
    apis.findFirst.mockResolvedValue(api({}));
    const { service } = setup(false);
    await expect(service.update(TENANT, ID, { expectedRevision: revisionOf({}), dropOrphans: true })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses classic, TCP and spec-less APIs (400), and another tenant\'s API (404)', async () => {
    const body = { expectedRevision: revisionOf({}), dropOrphans: true };
    apis.findFirst.mockResolvedValue(api({}, { defFormat: 'CLASSIC' }));
    await expect(setup().service.update(TENANT, ID, body)).rejects.toBeInstanceOf(BadRequestException);
    apis.findFirst.mockResolvedValue(api({}, { protocol: 'TCP' }));
    await expect(setup().service.update(TENANT, ID, body)).rejects.toBeInstanceOf(BadRequestException);
    apis.findFirst.mockResolvedValue(api({}));
    specs.findFirst.mockResolvedValue(null);
    await expect(setup().service.update(TENANT, ID, body)).rejects.toBeInstanceOf(BadRequestException);
    apis.findFirst.mockResolvedValue(null);
    await expect(setup().service.update('tenant-b', ID, body)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns a model refusal into a 400 with its reason', async () => {
    apis.findFirst.mockResolvedValue(api({ cache: { timeoutSeconds: 30 } }));
    const err = await setup()
      .service.update(TENANT, ID, { expectedRevision: revisionOf({}), keys: ['listOrders'], set: { cache: { timeoutSeconds: 5 } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toMatch(/API-wide cache/);
  });
});
