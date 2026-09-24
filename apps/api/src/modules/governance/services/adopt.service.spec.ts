import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { AuditService } from '../../audit/services/audit.service';
import { GovernanceAdoptService, ADOPT_RESOURCE, ADOPT_EVENT } from './adopt.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    apiDefinition: { findFirst: jest.fn(), update: jest.fn() },
  },
}));

interface MockDb {
  apiDefinition: { findFirst: jest.Mock; update: jest.Mock };
}
const db = prisma as unknown as MockDb;

const TENANT = 'tenant-1';
const API_ID = 'api-1';
const NODE_1 = 'http://tyk-gateway:8081/tyk';
const NODE_2 = 'http://tyk-gateway-2:8081/tyk';

describe('GovernanceAdoptService', () => {
  const tyk = {
    nodes: [NODE_1, NODE_2],
    getApiFromNode: jest.fn(),
    getOasApiFromNode: jest.fn(),
  };
  const audit = { recordOrThrow: jest.fn() };
  let service: GovernanceAdoptService;

  beforeEach(() => {
    jest.resetAllMocks();
    tyk.nodes = [NODE_1, NODE_2];
    service = new GovernanceAdoptService(
      tyk as unknown as TykClientService,
      audit as unknown as AuditService,
    );
  });

  it('rejects a node that is not in the configured node list — the SSRF guard', async () => {
    await expect(service.adopt(API_ID, 'http://attacker.internal:9999/tyk', TENANT)).rejects.toThrow(
      BadRequestException,
    );
    expect(db.apiDefinition.findFirst).not.toHaveBeenCalled();
    expect(tyk.getApiFromNode).not.toHaveBeenCalled();
    expect(tyk.getOasApiFromNode).not.toHaveBeenCalled();
  });

  it('404s for an API of another tenant or an unknown id', async () => {
    db.apiDefinition.findFirst.mockResolvedValue(null);

    await expect(service.adopt(API_ID, NODE_1, TENANT)).rejects.toThrow(NotFoundException);
  });

  it('refuses to adopt for an API that has never been synced to the gateway', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ id: API_ID, tykApiId: null, defFormat: 'OAS' });

    await expect(service.adopt(API_ID, NODE_1, TENANT)).rejects.toThrow(BadRequestException);
    expect(tyk.getOasApiFromNode).not.toHaveBeenCalled();
  });

  it('reads the OAS document for an OAS-format API, from the requested node specifically', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ id: API_ID, tykApiId: 'og-api-1', defFormat: 'OAS' });
    tyk.getOasApiFromNode.mockResolvedValue({ info: { title: 'Orders' }, paths: {} });
    db.apiDefinition.update.mockResolvedValue({});
    audit.recordOrThrow.mockResolvedValue(undefined);

    await service.adopt(API_ID, NODE_2, TENANT);

    expect(tyk.getOasApiFromNode).toHaveBeenCalledWith('og-api-1', NODE_2);
    expect(tyk.getApiFromNode).not.toHaveBeenCalled();
  });

  it('reads the classic definition for a CLASSIC-format API', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ id: API_ID, tykApiId: 'og-api-1', defFormat: 'CLASSIC' });
    tyk.getApiFromNode.mockResolvedValue({ target_url: 'http://x', listen_path: '/x/' });
    db.apiDefinition.update.mockResolvedValue({});
    audit.recordOrThrow.mockResolvedValue(undefined);

    await service.adopt(API_ID, NODE_1, TENANT);

    expect(tyk.getApiFromNode).toHaveBeenCalledWith('og-api-1', NODE_1);
    expect(tyk.getOasApiFromNode).not.toHaveBeenCalled();
  });

  it('stores the raw document with the sorted top-level field names, and writes a mandatory audit entry naming the node and fields', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ id: API_ID, tykApiId: 'og-api-1', defFormat: 'OAS' });
    const document = { paths: {}, info: {}, openapi: '3.0.3' };
    tyk.getOasApiFromNode.mockResolvedValue(document);
    db.apiDefinition.update.mockResolvedValue({});
    audit.recordOrThrow.mockResolvedValue(undefined);

    const result = await service.adopt(API_ID, NODE_1, TENANT);

    expect(result.adoptedFields).toEqual(['info', 'openapi', 'paths']);
    const [updateArgs] = db.apiDefinition.update.mock.calls[0] as [
      { where: { id: string }; data: { adoptedFromGateway: Record<string, unknown> } },
    ];
    expect(updateArgs.where).toEqual({ id: API_ID });
    expect(updateArgs.data.adoptedFromGateway).toMatchObject({
      node: NODE_1,
      document,
      adoptedFields: ['info', 'openapi', 'paths'],
    });

    expect(audit.recordOrThrow).toHaveBeenCalledWith({
      tenantId: TENANT,
      action: 'UPDATED',
      resource: ADOPT_RESOURCE,
      details: { event: ADOPT_EVENT, apiDefId: API_ID, node: NODE_1, adoptedFields: ['info', 'openapi', 'paths'] },
    });
  });

  it('labels the response as an override, not a routine sync', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ id: API_ID, tykApiId: 'og-api-1', defFormat: 'OAS' });
    tyk.getOasApiFromNode.mockResolvedValue({ openapi: '3.0.3' });
    db.apiDefinition.update.mockResolvedValue({});
    audit.recordOrThrow.mockResolvedValue(undefined);

    const result = await service.adopt(API_ID, NODE_1, TENANT);

    expect(result.message).toMatch(/overriding/i);
    expect(result.message).toMatch(/config of record/i);
    expect(result.message).toMatch(/escape hatch/i);
    expect(result.message).toMatch(/not a routine sync/i);
  });

  it('propagates a failed audit write rather than reporting success — the entry is mandatory, not best-effort', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ id: API_ID, tykApiId: 'og-api-1', defFormat: 'OAS' });
    tyk.getOasApiFromNode.mockResolvedValue({ openapi: '3.0.3' });
    db.apiDefinition.update.mockResolvedValue({});
    audit.recordOrThrow.mockRejectedValue(new Error('audit db down'));

    await expect(service.adopt(API_ID, NODE_1, TENANT)).rejects.toThrow('audit db down');
  });
});
