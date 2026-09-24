import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { WebhookSubscriptionService } from './webhook-subscription.service';
import type { ApiService } from '../../api-management/services/api.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    apiDefinition: { findUnique: jest.fn(), update: jest.fn() },
    webhookSubscription: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn(), count: jest.fn() },
    webhookDelivery: { findMany: jest.fn(), count: jest.fn() },
  },
}));

type Fn = jest.Mock;
const db = {
  api: prisma.apiDefinition as unknown as Record<'findUnique' | 'update', Fn>,
  sub: prisma.webhookSubscription as unknown as Record<'create' | 'findMany' | 'findUnique' | 'delete' | 'count', Fn>,
  delivery: prisma.webhookDelivery as unknown as Record<'findMany' | 'count', Fn>,
};

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

function apiRow(overrides: Record<string, unknown> = {}) {
  return { id: 'api-1', tenantId: TENANT, defFormat: 'OAS', protocol: 'HTTP', webhooksEnabled: false, ...overrides };
}

function subRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    tenantId: TENANT,
    apiId: 'api-1',
    receiverUrl: 'https://example.com/hook',
    secret: 'shh',
    active: true,
    createdAt: new Date(0),
    ...overrides,
  };
}

describe('WebhookSubscriptionService', () => {
  let apiService: { syncNowWithNodes: Fn };
  let service: WebhookSubscriptionService;

  beforeEach(() => {
    jest.resetAllMocks();
    apiService = { syncNowWithNodes: jest.fn().mockResolvedValue(undefined) };
    service = new WebhookSubscriptionService(apiService as unknown as ApiService);
  });

  describe('create', () => {
    it('creates a subscription, returns the raw secret once, and enables + syncs a first-time api', async () => {
      db.api.findUnique.mockResolvedValue(apiRow());
      db.sub.create.mockResolvedValue(subRow());

      const result = await service.create({ apiId: 'api-1', receiverUrl: 'https://example.com/hook' }, TENANT);

      expect(result.secret).toBeDefined();
      expect(typeof result.secret).toBe('string');
      expect(db.api.update).toHaveBeenCalledWith({ where: { id: 'api-1' }, data: { webhooksEnabled: true } });
      expect(apiService.syncNowWithNodes).toHaveBeenCalledWith('api-1', TENANT);
    });

    it('does not re-enable/re-sync when the api already has webhooks enabled', async () => {
      db.api.findUnique.mockResolvedValue(apiRow({ webhooksEnabled: true }));
      db.sub.create.mockResolvedValue(subRow());

      await service.create({ apiId: 'api-1', receiverUrl: 'https://example.com/hook' }, TENANT);

      expect(db.api.update).not.toHaveBeenCalled();
      expect(apiService.syncNowWithNodes).not.toHaveBeenCalled();
    });

    it('refuses a CLASSIC-format api', async () => {
      db.api.findUnique.mockResolvedValue(apiRow({ defFormat: 'CLASSIC' }));

      await expect(service.create({ apiId: 'api-1', receiverUrl: 'https://example.com/hook' }, TENANT)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a TCP-protocol api', async () => {
      db.api.findUnique.mockResolvedValue(apiRow({ protocol: 'TCP' }));

      await expect(service.create({ apiId: 'api-1', receiverUrl: 'https://example.com/hook' }, TENANT)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s on a cross-tenant or missing api', async () => {
      db.api.findUnique.mockResolvedValue(apiRow({ tenantId: OTHER_TENANT }));

      await expect(service.create({ apiId: 'api-1', receiverUrl: 'https://example.com/hook' }, TENANT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findOne', () => {
    it('403s on a cross-tenant subscription', async () => {
      db.sub.findUnique.mockResolvedValue(subRow({ tenantId: OTHER_TENANT }));

      await expect(service.findOne('sub-1', TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('never returns the secret on a plain read', async () => {
      db.sub.findUnique.mockResolvedValue(subRow());

      const result = await service.findOne('sub-1', TENANT);

      expect(result.secret).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('disables webhooksEnabled and re-syncs when the last active subscription is removed', async () => {
      db.sub.findUnique.mockResolvedValue(subRow());
      db.sub.count.mockResolvedValue(0);

      await service.remove('sub-1', TENANT);

      expect(db.api.update).toHaveBeenCalledWith({ where: { id: 'api-1' }, data: { webhooksEnabled: false } });
      expect(apiService.syncNowWithNodes).toHaveBeenCalledWith('api-1', TENANT);
    });

    it('leaves webhooksEnabled alone when other active subscriptions remain', async () => {
      db.sub.findUnique.mockResolvedValue(subRow());
      db.sub.count.mockResolvedValue(1);

      await service.remove('sub-1', TENANT);

      expect(db.api.update).not.toHaveBeenCalled();
      expect(apiService.syncNowWithNodes).not.toHaveBeenCalled();
    });
  });
});
