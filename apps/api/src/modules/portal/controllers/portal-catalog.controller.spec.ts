import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { ApiDefinition } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { mapToTykOas } from '../../api-management/services/tyk-mappers';
import type { ApiService } from '../../api-management/services/api.service';
import { PortalApiDocService } from '../services/portal-api-doc.service';
import type { PlanService } from '../../plans/services/plan.service';
import type { ProductService } from '../../products/services/product.service';
import type { DeveloperPayload } from '../../../common/types';
import { PortalCatalogController } from './portal-catalog.controller';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    tenant: { findUniqueOrThrow: jest.fn() },
    apiSpec: { findFirst: jest.fn() },
    productApi: { findFirst: jest.fn() },
  },
}));

const db = prisma as unknown as {
  tenant: { findUniqueOrThrow: jest.Mock };
  apiSpec: { findFirst: jest.Mock };
  productApi: { findFirst: jest.Mock };
};

const TENANT = { tykOrgId: 'og-t1', slug: 'acme' };
const DEVELOPER: DeveloperPayload = { sub: 'dev-1', tenantId: 'tenant-1', email: 'd@example.test', name: 'Dev' };
const API_ID = '11111111-1111-1111-1111-111111111111';

// Hosts a developer must never learn from the portal: the upstream and its load-balancer / probe targets.
const INTERNAL_HOSTS = ['internal-orders.corp', 'internal-lb-2.corp', 'internal-probe.corp'];

/** A real row shape, so the generated document below is what `mapToTykOas` really emits for it. */
function apiDef(): ApiDefinition {
  return {
    id: 'a1',
    tenantId: 'tenant-1',
    name: 'Orders',
    slug: 'orders',
    tykApiId: null,
    proxyUrl: 'http://internal-orders.corp:8443/v1',
    listenPath: '/orders/',
    authType: 'AUTH_TOKEN',
    status: 'ACTIVE',
    config: {
      loadBalancing: { targets: [{ url: 'http://internal-lb-2.corp:9000', weight: 1 }] },
      uptimeTests: [{ url: 'http://internal-probe.corp/health' }],
    },
    syncStatus: 'SYNCED',
    syncError: null,
    syncState: null,
    defFormat: 'OAS',
    parentApiId: null,
    retiredAt: null,
    versionName: null,
    oasDocument: null,
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as ApiDefinition;
}

function controllerOver(findOne: jest.Mock): PortalCatalogController {
  const apis = { findOne } as unknown as ApiService;
  return new PortalCatalogController({} as ProductService, {} as PlanService, new PortalApiDocService(apis));
}

beforeEach(() => {
  jest.resetAllMocks();
  db.tenant.findUniqueOrThrow.mockResolvedValue(TENANT);
  db.apiSpec.findFirst.mockResolvedValue(null);
  db.productApi.findFirst.mockResolvedValue({ productId: 'product-1' });
});

describe('PortalCatalogController.findApi', () => {
  // MOCKED persistence: the controller, the service, the mapper and the sanitizer are real; the rows are fakes.
  it('serves a document that names no upstream host and no x-tyk-* extension (the generated one)', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: API_ID,
      name: 'Orders',
      authType: 'AUTH_TOKEN',
      status: 'ACTIVE',
      listenPath: '/orders/',
      config: {},
      oasDocument: mapToTykOas(apiDef(), TENANT),
    });

    const response = await controllerOver(findOne).findApi(API_ID, DEVELOPER);

    const wire = JSON.stringify(response.oasDocument);
    expect(wire).not.toContain('x-tyk-');
    for (const host of INTERNAL_HOSTS) expect(wire).not.toContain(host);
    expect(response.oasDocument?.servers).toEqual([{ url: '/acme/orders' }]);
  });

  it('scopes the read to the developer\'s own tenant and answers 404 for another tenant\'s API', async () => {
    const findOne = jest.fn().mockRejectedValue(new NotFoundException('API not found'));

    await expect(controllerOver(findOne).findApi(API_ID, DEVELOPER)).rejects.toBeInstanceOf(NotFoundException);

    expect(findOne).toHaveBeenCalledWith(API_ID, DEVELOPER.tenantId);
    expect(db.apiSpec.findFirst).not.toHaveBeenCalled();
  });
});
