import 'reflect-metadata';
import { BadGatewayException, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { HydraAdminService } from './hydra-admin.service';
import { OAuthClientService } from './oauth-client.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    apiDefinition: { findUnique: jest.fn() },
    // WP12c: every gateway write resolves the tenant's org through `loadTenantScope`.
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' }) },
  },
}));

const db = prisma as unknown as { apiDefinition: { findUnique: jest.Mock } };

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const API_ID = 'api-1';
const CLIENT_ID = 'client-1';

const apiRow = (over: Record<string, unknown> = {}) => ({
  id: API_ID,
  tenantId: TENANT,
  name: 'Orders',
  authType: 'OAUTH',
  tykApiId: 'gw-123',
  config: { rateLimit: { rate: 100, per: 60 } },
  ...over,
});

const hydraClient = (over: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: 'Partner',
  created_at: '2026-01-01T00:00:00Z',
  metadata: { tenantId: TENANT, apiDefId: API_ID },
  ...over,
});

describe('OAuthClientService', () => {
  let hydra: jest.Mocked<Pick<HydraAdminService, 'create' | 'find' | 'listByOwner' | 'replace' | 'remove'>>;
  let tyk: jest.Mocked<Pick<TykClientService, 'upsertPolicy' | 'deletePolicy'>>;
  let service: OAuthClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-armed here because `resetAllMocks` clears return values: every gateway write resolves
    // the tenant's org through `loadTenantScope` (WP12c).
    (prisma.tenant.findUniqueOrThrow as jest.Mock).mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    hydra = {
      create: jest.fn(),
      find: jest.fn(),
      listByOwner: jest.fn(),
      replace: jest.fn(),
      remove: jest.fn(),
    } as unknown as typeof hydra;
    tyk = { upsertPolicy: jest.fn(), deletePolicy: jest.fn() } as unknown as typeof tyk;

    const config = { get: jest.fn().mockReturnValue('http://localhost:33010/') } as unknown as ConfigService;
    service = new OAuthClientService(
      hydra as unknown as HydraAdminService,
      tyk as unknown as TykClientService,
      config,
    );
  });

  describe('create', () => {
    it('creates the client, then a policy whose id is the client id', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiRow());
      hydra.create.mockResolvedValue(hydraClient());

      const result = await service.create({ apiDefId: API_ID, name: 'Partner' }, TENANT);

      expect(tyk.upsertPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: CLIENT_ID,
          access_rights: { 'gw-123': { api_id: 'gw-123', api_name: 'Orders', versions: ['Default'] } },
        }),
      );
      expect(result.clientId).toBe(CLIENT_ID);
      expect(result.clientSecret).toHaveLength(43);
      expect(result.tokenUrl).toBe('http://localhost:33010/oauth2/token');
    });

    it('removes the client when its policy could not be written', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiRow());
      hydra.create.mockResolvedValue(hydraClient());
      tyk.upsertPolicy.mockRejectedValue(new Error('gateway down'));

      await expect(service.create({ apiDefId: API_ID, name: 'Partner' }, TENANT)).rejects.toThrow(
        BadGatewayException,
      );
      expect(hydra.remove).toHaveBeenCalledWith(CLIENT_ID);
    });

    it('rejects an invalid quota before creating anything in Hydra', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiRow());

      await expect(
        service.create({ apiDefId: API_ID, name: 'Partner', quotaLimit: 10 }, TENANT),
      ).rejects.toThrow(BadRequestException);
      expect(hydra.create).not.toHaveBeenCalled();
    });

    it('refuses an API that does not use OAuth2', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiRow({ authType: 'AUTH_TOKEN' }));

      await expect(service.create({ apiDefId: API_ID, name: 'Partner' }, TENANT)).rejects.toThrow(
        BadRequestException,
      );
      expect(hydra.create).not.toHaveBeenCalled();
    });

    it("refuses another tenant's API as not found", async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiRow({ tenantId: OTHER_TENANT }));

      await expect(service.create({ apiDefId: API_ID, name: 'Partner' }, TENANT)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByApi', () => {
    it('returns only the clients of that API, newest first', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiRow());
      hydra.listByOwner.mockResolvedValue([
        hydraClient({ client_id: 'old', created_at: '2026-01-01T00:00:00Z' }),
        hydraClient({ client_id: 'other-api', metadata: { tenantId: TENANT, apiDefId: 'api-9' } }),
        hydraClient({ client_id: 'new', created_at: '2026-02-01T00:00:00Z' }),
      ]);

      const result = await service.findByApi(API_ID, TENANT);

      expect(hydra.listByOwner).toHaveBeenCalledWith(TENANT);
      expect(result.map((client) => client.clientId)).toEqual(['new', 'old']);
    });
  });

  describe('rotate', () => {
    it('replaces only the secret, keeping the client id and its policy', async () => {
      hydra.find.mockResolvedValue(hydraClient());
      hydra.replace.mockResolvedValue(hydraClient());

      const result = await service.rotate(CLIENT_ID, TENANT);

      const [, sent] = hydra.replace.mock.calls[0] as [string, Record<string, unknown>];
      expect(sent.client_secret).toBe(result.clientSecret);
      expect(sent.metadata).toEqual({ tenantId: TENANT, apiDefId: API_ID });
      expect(tyk.upsertPolicy).not.toHaveBeenCalled();
      expect(result.clientId).toBe(CLIENT_ID);
    });

    it("hides another tenant's client behind a 404", async () => {
      hydra.find.mockResolvedValue(hydraClient({ metadata: { tenantId: OTHER_TENANT, apiDefId: API_ID } }));

      await expect(service.rotate(CLIENT_ID, TENANT)).rejects.toThrow(NotFoundException);
      expect(hydra.replace).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('deletes the gateway policy before the client, so live tokens stop working', async () => {
      hydra.find.mockResolvedValue(hydraClient());
      const order: string[] = [];
      tyk.deletePolicy.mockImplementation(() => {
        order.push('policy');
        return Promise.resolve([]);
      });
      hydra.remove.mockImplementation(() => {
        order.push('client');
        return Promise.resolve();
      });

      await service.revoke(CLIENT_ID, TENANT);

      expect(order).toEqual(['policy', 'client']);
    });

    it('keeps the client when the policy could not be removed', async () => {
      hydra.find.mockResolvedValue(hydraClient());
      tyk.deletePolicy.mockRejectedValue(new Error('connection refused'));

      await expect(service.revoke(CLIENT_ID, TENANT)).rejects.toThrow(BadGatewayException);
      expect(hydra.remove).not.toHaveBeenCalled();
    });

    it("hides another tenant's client behind a 404", async () => {
      hydra.find.mockResolvedValue(hydraClient({ metadata: { tenantId: OTHER_TENANT, apiDefId: API_ID } }));

      await expect(service.revoke(CLIENT_ID, TENANT)).rejects.toThrow(NotFoundException);
      expect(tyk.deletePolicy).not.toHaveBeenCalled();
    });
  });
});
