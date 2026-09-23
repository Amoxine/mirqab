import 'reflect-metadata';
import { BadGatewayException, BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ApiKeyStatus, Prisma, QuotaPeriod } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import type { QuotaService } from '../../quotas/services/quota.service';
import { analyticsWindow, keyRollupQuery } from '../../analytics/services/pump-query.builder';
import { KeyService } from './key.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    // WP12c: every gateway write resolves the tenant's org through `loadTenantScope`.
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' }) },
    apiKey: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
    apiDefinition: { findUnique: jest.fn() },
    // WP18: create() looks up a planId's ownership before building the key.
    plan: { findFirst: jest.fn() },
    quota: { deleteMany: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

interface MockDb {
  apiKey: Record<'findUnique' | 'findMany' | 'count' | 'create' | 'update', jest.Mock>;
  apiDefinition: { findUnique: jest.Mock };
  plan: { findFirst: jest.Mock };
  quota: { deleteMany: jest.Mock };
  $queryRaw: jest.Mock;
}
// The mocked module above replaces the real client; only the methods KeyService uses exist on it.
const db = prisma as unknown as MockDb;

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const KEY_ID = 'key-1';
const HASH = 'e9a7cdb92e3a5546';
const RAW_KEY = 'raw-secret-key-value';
const SHA = 'sha256-of-the-raw-key';
const NOW_MS = 1_800_000_000_000;

const keyRow = (over: Record<string, unknown> = {}) => ({
  id: KEY_ID,
  tenantId: TENANT,
  userId: 'user-1',
  name: 'wp3 key',
  tykKeyId: HASH,
  keyHash: SHA,
  status: ApiKeyStatus.ACTIVE,
  expiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  apiDefId: 'api-1',
  apiDef: { name: 'Orders API', tykApiId: 'tyk-api-1' },
  ...over,
});

const RIGHTS = { 'tyk-api-1': { api_id: 'tyk-api-1', api_name: 'Orders API', versions: ['Default'] } };
const tykState = {
  alias: 'wp3 key',
  rate: 10,
  per: 1,
  quota_max: 1000,
  quota_remaining: 640,
  quota_renewal_rate: 3600,
  quota_renews: 1_800_003_600,
  access_rights: RIGHTS,
};

const missingTable = () =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: '42P01', message: 'relation "public.tyk_aggregated" does not exist' },
  });

describe('KeyService', () => {
  const tyk = {
    createKey: jest.fn(),
    getKey: jest.fn(),
    updateKey: jest.fn(),
    deleteKey: jest.fn(),
    upsertPolicy: jest.fn(),
    deletePolicy: jest.fn(),
  };
  const quotas = { create: jest.fn(), upsert: jest.fn() };
  let service: KeyService;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // Re-armed here because `resetAllMocks` clears return values: every gateway write resolves
    // the tenant's org through `loadTenantScope` (WP12c).
    (prisma.tenant.findUniqueOrThrow as jest.Mock).mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' });
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    service = new KeyService(tyk as unknown as TykClientService, quotas as unknown as QuotaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create', () => {
    const apiDef = { id: 'api-1', tenantId: TENANT, name: 'Orders API', tykApiId: 'tyk-api-1' };
    const dto = {
      name: 'wp3 key',
      apiDefId: 'api-1',
      rateLimitPerSecond: 10,
      quotaLimit: 1000,
      quotaPeriod: QuotaPeriod.HOURLY,
    };

    it('maps the DTO to Tyk, stores the Tyk key hash (never the raw key) and returns the raw key once', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiDef);
      tyk.createKey.mockResolvedValue({ keyHash: HASH, key: RAW_KEY });
      db.apiKey.create.mockResolvedValue(keyRow());

      const created = await service.create(dto, TENANT, 'user-1');

      expect(tyk.createKey).toHaveBeenCalledWith(
        expect.objectContaining({
          alias: 'wp3 key',
          rate: 10,
          per: 1,
          quota_max: 1000,
          quota_renewal_rate: 3600,
          access_rights: RIGHTS,
        }),
      );
      const stored = (db.apiKey.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
      expect(stored.tykKeyId).toBe(HASH);
      expect(JSON.stringify(stored)).not.toContain(RAW_KEY);
      expect(quotas.create).toHaveBeenCalledWith(KEY_ID, 1000, QuotaPeriod.HOURLY);
      expect(created.keyValue).toBe(RAW_KEY);
    });

    it('rejects an API of another tenant with 404 and never calls Tyk', async () => {
      db.apiDefinition.findUnique.mockResolvedValue({ ...apiDef, tenantId: OTHER_TENANT });

      await expect(service.create(dto, TENANT, 'user-1')).rejects.toThrow(NotFoundException);
      expect(tyk.createKey).not.toHaveBeenCalled();
    });

    it('rejects an API that is not synced to the gateway yet', async () => {
      db.apiDefinition.findUnique.mockResolvedValue({ ...apiDef, tykApiId: null });

      await expect(service.create(dto, TENANT, 'user-1')).rejects.toThrow(BadRequestException);
      expect(tyk.createKey).not.toHaveBeenCalled();
    });

    // B7a: without this the gateway keeps a live key the app cannot see, list or revoke.
    it('deletes the gateway key again when the database row cannot be written', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiDef);
      tyk.createKey.mockResolvedValue({ keyHash: HASH, key: RAW_KEY });
      tyk.deleteKey.mockResolvedValue(undefined);
      db.apiKey.create.mockRejectedValue(new Error('database is in recovery'));

      await expect(service.create(dto, TENANT, 'user-1')).rejects.toThrow('database is in recovery');
      expect(tyk.deleteKey).toHaveBeenCalledWith(HASH);
      expect(quotas.create).not.toHaveBeenCalled();
    });

    it('still surfaces the original failure when the compensating delete also fails', async () => {
      db.apiDefinition.findUnique.mockResolvedValue(apiDef);
      tyk.createKey.mockResolvedValue({ keyHash: HASH, key: RAW_KEY });
      db.apiKey.create.mockRejectedValue(new Error('database is in recovery'));
      tyk.deleteKey.mockRejectedValue(new BadRequestException('Tyk integration error: boom'));

      await expect(service.create(dto, TENANT, 'user-1')).rejects.toThrow('database is in recovery');
    });

    /**
     * WP18 fix: `apply_policies` needs a second, ACL-owning policy alongside the plan's own
     * (ACL-less by design) one, or Tyk refuses to create the key at all — live-verified against
     * Tyk 5.15.0. See `buildKeyAclPolicy`'s doc comment.
     */
    describe('with a plan (companion ACL policy)', () => {
      const PLAN_ID = 'plan-1';
      const planDto = { name: 'wp18 key', apiDefId: 'api-1', planId: PLAN_ID };

      it('pushes the ACL policy before creating the key, and applies both policies', async () => {
        db.apiDefinition.findUnique.mockResolvedValue(apiDef);
        db.plan.findFirst.mockResolvedValue({ id: PLAN_ID });
        tyk.upsertPolicy.mockResolvedValue([]);
        tyk.createKey.mockResolvedValue({ keyHash: HASH, key: RAW_KEY });
        db.apiKey.create.mockResolvedValue(keyRow({ planId: PLAN_ID }));

        await service.create(planDto, TENANT, 'user-1');

        expect(tyk.upsertPolicy).toHaveBeenCalledTimes(1);
        const aclPolicy = (tyk.upsertPolicy.mock.calls[0] as [Record<string, unknown>])[0];
        expect(aclPolicy).toMatchObject({
          access_rights: RIGHTS,
          partitions: { acl: true, quota: false, rate_limit: false, complexity: false, per_api: false },
        });
        // The key references the policy's id, so the policy must exist on the gateway first.
        expect(tyk.upsertPolicy.mock.invocationCallOrder[0]).toBeLessThan(tyk.createKey.mock.invocationCallOrder[0]);

        expect(tyk.createKey).toHaveBeenCalledWith(
          expect.objectContaining({ apply_policies: [PLAN_ID, aclPolicy.id] }),
        );
        const stored = (db.apiKey.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
        expect(stored.tykAclPolicyId).toBe(aclPolicy.id);
        expect(stored.planId).toBe(PLAN_ID);
      });

      it('rejects an unknown plan before touching Tyk at all', async () => {
        db.apiDefinition.findUnique.mockResolvedValue(apiDef);
        db.plan.findFirst.mockResolvedValue(null);

        await expect(service.create(planDto, TENANT, 'user-1')).rejects.toThrow(BadRequestException);
        expect(tyk.upsertPolicy).not.toHaveBeenCalled();
        expect(tyk.createKey).not.toHaveBeenCalled();
      });

      it('deletes the ACL policy too when key creation on the gateway fails', async () => {
        db.apiDefinition.findUnique.mockResolvedValue(apiDef);
        db.plan.findFirst.mockResolvedValue({ id: PLAN_ID });
        tyk.upsertPolicy.mockResolvedValue([]);
        tyk.createKey.mockRejectedValue(new Error('gateway down'));
        tyk.deletePolicy.mockResolvedValue([]);

        await expect(service.create(planDto, TENANT, 'user-1')).rejects.toThrow(BadRequestException);

        const aclPolicy = (tyk.upsertPolicy.mock.calls[0] as [Record<string, unknown>])[0];
        expect(tyk.deletePolicy).toHaveBeenCalledWith(aclPolicy.id);
        expect(db.apiKey.create).not.toHaveBeenCalled();
      });

      it('deletes both the gateway key and its ACL policy when the database row cannot be written', async () => {
        db.apiDefinition.findUnique.mockResolvedValue(apiDef);
        db.plan.findFirst.mockResolvedValue({ id: PLAN_ID });
        tyk.upsertPolicy.mockResolvedValue([]);
        tyk.createKey.mockResolvedValue({ keyHash: HASH, key: RAW_KEY });
        tyk.deleteKey.mockResolvedValue(undefined);
        tyk.deletePolicy.mockResolvedValue([]);
        db.apiKey.create.mockRejectedValue(new Error('database is in recovery'));

        await expect(service.create(planDto, TENANT, 'user-1')).rejects.toThrow('database is in recovery');

        const aclPolicy = (tyk.upsertPolicy.mock.calls[0] as [Record<string, unknown>])[0];
        expect(tyk.deleteKey).toHaveBeenCalledWith(HASH);
        expect(tyk.deletePolicy).toHaveBeenCalledWith(aclPolicy.id);
      });

      it('creates no ACL policy when the key has no API to scope — apply_policies is the plan alone', async () => {
        db.plan.findFirst.mockResolvedValue({ id: PLAN_ID });
        tyk.createKey.mockResolvedValue({ keyHash: HASH, key: RAW_KEY });
        db.apiKey.create.mockResolvedValue(keyRow({ planId: PLAN_ID, tykAclPolicyId: null }));

        await service.create({ name: 'no-api key', planId: PLAN_ID }, TENANT, 'user-1');

        expect(tyk.upsertPolicy).not.toHaveBeenCalled();
        expect(tyk.createKey).toHaveBeenCalledWith(expect.objectContaining({ apply_policies: [PLAN_ID] }));
        const stored = (db.apiKey.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
        expect(stored.tykAclPolicyId).toBeNull();
      });
    });
  });

  describe('findAll', () => {
    it('scopes to the tenant, applies the apiDefId filter and exposes the API name', async () => {
      db.apiKey.findMany.mockResolvedValue([
        { id: KEY_ID, name: 'k', status: 'ACTIVE', expiresAt: null, createdAt: new Date(), apiDefId: 'api-1', apiDef: { name: 'Orders API' } },
        { id: 'key-2', name: 'k2', status: 'ACTIVE', expiresAt: null, createdAt: new Date(), apiDefId: null, apiDef: null },
      ]);
      db.apiKey.count.mockResolvedValue(2);

      const page = await service.findAll(TENANT, 1, 20, undefined, 'api-1');

      expect(db.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT, apiDefId: 'api-1' } }),
      );
      expect(page.data.map((k) => k.apiDefName)).toEqual(['Orders API', null]);
      expect(page.data[0]).not.toHaveProperty('apiDef');
      expect(page.meta).toEqual({ page: 1, pageSize: 20, totalCount: 2, totalPages: 1 });
    });

    // B7c: page=0 produced a negative skip (Prisma 500) and pageSize was unbounded.
    it('clamps page to >= 1 and pageSize to 1..100', async () => {
      db.apiKey.findMany.mockResolvedValue([]);
      db.apiKey.count.mockResolvedValue(0);

      const page = await service.findAll(TENANT, 0, 100_000);

      expect(db.apiKey.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
      expect(page.meta).toMatchObject({ page: 1, pageSize: 100 });
    });

    it('clamps a negative pageSize up to 1 and keeps the requested page', async () => {
      db.apiKey.findMany.mockResolvedValue([]);
      db.apiKey.count.mockResolvedValue(0);

      await service.findAll(TENANT, 3, -5);

      expect(db.apiKey.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 1 }));
    });
  });

  describe('findOne', () => {
    it('404s for a key of another tenant without asking the gateway', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ tenantId: OTHER_TENANT }));

      await expect(service.findOne(KEY_ID, TENANT)).rejects.toThrow(NotFoundException);
      expect(tyk.getKey).not.toHaveBeenCalled();
    });

    it('404s for an unknown key', async () => {
      db.apiKey.findUnique.mockResolvedValue(null);

      await expect(service.findOne(KEY_ID, TENANT)).rejects.toThrow(NotFoundException);
    });

    it('returns the live Tyk limits and never leaks tykKeyId / keyHash / the hash values', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.getKey.mockResolvedValue(tykState);

      const detail = await service.findOne(KEY_ID, TENANT);

      expect(tyk.getKey).toHaveBeenCalledWith(HASH);
      expect(detail.tyk).toEqual({
        rate: 10,
        per: 1,
        quotaMax: 1000,
        quotaRemaining: 640,
        quotaRenewalRate: 3600,
        quotaRenewsAt: new Date(1_800_003_600 * 1000),
      });
      expect(detail.apiDefName).toBe('Orders API');
      const json = JSON.stringify(detail);
      for (const secret of ['tykKeyId', 'keyHash', HASH, SHA]) {
        expect(json).not.toContain(secret);
      }
    });

    it('reads an absent quota_remaining as the full quota, not an exhausted one', async () => {
      // Tyk omits quota_remaining until the key's first request; 0 would render a brand-new key
      // as "1,000 / 1,000 used" with a full red quota bar.
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      const { quota_remaining: _omitted, ...fresh } = tykState;
      tyk.getKey.mockResolvedValue(fresh);

      const detail = await service.findOne(KEY_ID, TENANT);

      expect(detail.tyk?.quotaRemaining).toBe(1000);
      expect(detail.tyk?.quotaMax).toBe(1000);
    });

    it('still reports an exhausted quota when Tyk really sends 0', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.getKey.mockResolvedValue({ ...tykState, quota_remaining: 0 });

      expect((await service.findOne(KEY_ID, TENANT)).tyk?.quotaRemaining).toBe(0);
    });

    it('returns tyk: null, not an error, when the gateway cannot be reached', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.getKey.mockRejectedValue(new TypeError('fetch failed'));

      const detail = await service.findOne(KEY_ID, TENANT);

      expect(detail.tyk).toBeNull();
      expect(detail.id).toBe(KEY_ID);
    });

    it('does not ask the gateway about a revoked key', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));

      const detail = await service.findOne(KEY_ID, TENANT);

      expect(detail.tyk).toBeNull();
      expect(tyk.getKey).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('404s for a key of another tenant and 409s for a revoked key, touching nothing', async () => {
      db.apiKey.findUnique.mockResolvedValueOnce(keyRow({ tenantId: OTHER_TENANT }));
      await expect(service.update(KEY_ID, { name: 'x' }, TENANT)).rejects.toThrow(NotFoundException);

      db.apiKey.findUnique.mockResolvedValueOnce(keyRow({ status: ApiKeyStatus.REVOKED }));
      await expect(service.update(KEY_ID, { name: 'x' }, TENANT)).rejects.toThrow(ConflictException);

      expect(tyk.getKey).not.toHaveBeenCalled();
      expect(tyk.updateKey).not.toHaveBeenCalled();
      expect(db.apiKey.update).not.toHaveBeenCalled();
    });

    it('PUTs the merged definition by key hash, updates the local row and returns the fresh detail', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.getKey.mockResolvedValue(tykState);

      const detail = await service.update(
        KEY_ID,
        { name: 'renamed', rateLimitPerSecond: 25, quotaLimit: 500, quotaPeriod: QuotaPeriod.HOURLY },
        TENANT,
      );

      expect(tyk.updateKey).toHaveBeenCalledWith(
        HASH,
        expect.objectContaining({
          alias: 'renamed',
          rate: 25,
          per: 1,
          quota_max: 500,
          quota_renewal_rate: 3600,
          access_rights: RIGHTS,
        }),
      );
      expect(db.apiKey.update).toHaveBeenCalledWith({ where: { id: KEY_ID }, data: { name: 'renamed' } });
      expect(quotas.upsert).toHaveBeenCalledWith(KEY_ID, 500, QuotaPeriod.HOURLY);
      expect(detail.id).toBe(KEY_ID);
      expect(JSON.stringify(detail)).not.toContain(HASH);
    });

    it('quotaLimit 0 removes the local quota row', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.getKey.mockResolvedValue(tykState);

      await service.update(KEY_ID, { quotaLimit: 0 }, TENANT);

      expect(db.quota.deleteMany).toHaveBeenCalledWith({ where: { apiKeyId: KEY_ID } });
      expect(quotas.upsert).not.toHaveBeenCalled();
    });

    it('clears the local expiry for null and parses an ISO date otherwise', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.getKey.mockResolvedValue(tykState);

      await service.update(KEY_ID, { expiresAt: null }, TENANT);
      await service.update(KEY_ID, { expiresAt: '2027-01-01T00:00:00.000Z' }, TENANT);

      const datas = db.apiKey.update.mock.calls.map((c) => (c as [{ data: { expiresAt: Date | null } }])[0].data.expiresAt);
      expect(datas).toEqual([null, new Date('2027-01-01T00:00:00.000Z')]);
    });

    it('502s and changes nothing locally when the gateway cannot be read or written', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());

      tyk.getKey.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(service.update(KEY_ID, { name: 'x' }, TENANT)).rejects.toThrow(BadGatewayException);
      expect(tyk.updateKey).not.toHaveBeenCalled();

      tyk.getKey.mockResolvedValueOnce(tykState);
      tyk.updateKey.mockRejectedValueOnce(new BadRequestException('Tyk integration error: boom'));
      await expect(service.update(KEY_ID, { name: 'x' }, TENANT)).rejects.toThrow(BadGatewayException);

      expect(db.apiKey.update).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('404s for another tenant and 409s when already revoked', async () => {
      db.apiKey.findUnique.mockResolvedValueOnce(keyRow({ tenantId: OTHER_TENANT }));
      await expect(service.revoke(KEY_ID, TENANT)).rejects.toThrow(NotFoundException);

      db.apiKey.findUnique.mockResolvedValueOnce(keyRow({ status: ApiKeyStatus.REVOKED }));
      await expect(service.revoke(KEY_ID, TENANT)).rejects.toThrow(ConflictException);

      expect(tyk.deleteKey).not.toHaveBeenCalled();
    });

    it('deletes the key from Tyk by its hash and marks it REVOKED', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      db.apiKey.update.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));

      const revoked = await service.revoke(KEY_ID, TENANT);

      expect(tyk.deleteKey).toHaveBeenCalledWith(HASH);
      expect(db.apiKey.update).toHaveBeenCalledWith({ where: { id: KEY_ID }, data: { status: ApiKeyStatus.REVOKED } });
      expect(revoked.status).toBe(ApiKeyStatus.REVOKED);
    });

    it.each(['Tyk integration error: Key not found', 'Tyk integration error: There is no such key found'])(
      'still marks the row REVOKED when Tyk does not know the key (%s)',
      async (message) => {
        db.apiKey.findUnique.mockResolvedValue(keyRow());
        tyk.deleteKey.mockRejectedValue(new BadRequestException(message));
        db.apiKey.update.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));

        await expect(service.revoke(KEY_ID, TENANT)).resolves.toMatchObject({ status: ApiKeyStatus.REVOKED });
        expect(db.apiKey.update).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['gateway unreachable', new TypeError('fetch failed')],
      ['gateway rejected the call', new BadRequestException('Tyk integration error: Access to this API has been disallowed')],
    ])('does NOT mark the key revoked when it may still be live in Tyk (%s)', async (_label, error) => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      tyk.deleteKey.mockRejectedValue(error);

      await expect(service.revoke(KEY_ID, TENANT)).rejects.toThrow(BadGatewayException);
      expect(db.apiKey.update).not.toHaveBeenCalled();
    });

    // WP18 fix: a plan-governed key's companion ACL policy (buildKeyAclPolicy) is its own — nothing
    // else references it, so revoking the key is what cleans it up.
    it('also deletes the ACL policy for a plan-governed key, after the gateway key is gone', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ planId: 'plan-1', tykAclPolicyId: 'acl-1' }));
      db.apiKey.update.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));
      tyk.deletePolicy.mockResolvedValue([]);

      await service.revoke(KEY_ID, TENANT);

      expect(tyk.deleteKey).toHaveBeenCalledWith(HASH);
      expect(tyk.deletePolicy).toHaveBeenCalledWith('acl-1');
      expect(tyk.deleteKey.mock.invocationCallOrder[0]).toBeLessThan(tyk.deletePolicy.mock.invocationCallOrder[0]);
    });

    it('does not touch a plan key that has no ACL policy (pre-fix key, or none was needed)', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ planId: 'plan-1', tykAclPolicyId: null }));
      db.apiKey.update.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));

      await service.revoke(KEY_ID, TENANT);

      expect(tyk.deletePolicy).not.toHaveBeenCalled();
    });

    it('still revokes the key even when its ACL policy fails to delete — the leak is logged, not fatal', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ planId: 'plan-1', tykAclPolicyId: 'acl-1' }));
      db.apiKey.update.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));
      tyk.deletePolicy.mockRejectedValue(new Error('policy delete failed'));

      await expect(service.revoke(KEY_ID, TENANT)).resolves.toMatchObject({ status: ApiKeyStatus.REVOKED });
    });

    it('does NOT delete the ACL policy when the Tyk key deletion genuinely fails (it may still reference it)', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ planId: 'plan-1', tykAclPolicyId: 'acl-1' }));
      tyk.deleteKey.mockRejectedValue(new TypeError('fetch failed'));

      await expect(service.revoke(KEY_ID, TENANT)).rejects.toThrow(BadGatewayException);
      expect(tyk.deletePolicy).not.toHaveBeenCalled();
    });
  });

  describe('checkExpired', () => {
    const expiredRow = (over: Record<string, unknown> = {}) =>
      keyRow({ expiresAt: new Date(NOW_MS - 1000), ...over });

    it('does nothing when no key has expired', async () => {
      db.apiKey.findMany.mockResolvedValue([]);

      await expect(service.checkExpired()).resolves.toBe(0);
      expect(tyk.deleteKey).not.toHaveBeenCalled();
      expect(db.apiKey.update).not.toHaveBeenCalled();
    });

    it('revokes on the gateway and marks the row EXPIRED', async () => {
      db.apiKey.findMany.mockResolvedValue([expiredRow()]);
      db.apiKey.update.mockResolvedValue(expiredRow({ status: ApiKeyStatus.EXPIRED }));

      await expect(service.checkExpired()).resolves.toBe(1);
      expect(tyk.deleteKey).toHaveBeenCalledWith(HASH);
      expect(db.apiKey.update).toHaveBeenCalledWith({
        where: { id: KEY_ID },
        data: { status: ApiKeyStatus.EXPIRED },
      });
    });

    // WP18 fix: expiry goes through the same deleteTykKey path as revoke, so a plan-governed key's
    // ACL policy is cleaned up here too, not left behind.
    it('also deletes a plan-governed key’s ACL policy on expiry', async () => {
      db.apiKey.findMany.mockResolvedValue([expiredRow({ planId: 'plan-1', tykAclPolicyId: 'acl-1' })]);
      db.apiKey.update.mockResolvedValue(expiredRow({ status: ApiKeyStatus.EXPIRED }));
      tyk.deletePolicy.mockResolvedValue([]);

      await expect(service.checkExpired()).resolves.toBe(1);
      expect(tyk.deletePolicy).toHaveBeenCalledWith('acl-1');
    });

    // B7b: an expired key the gateway already dropped used to throw, stay ACTIVE and be retried nightly.
    it.each(['Tyk integration error: Key not found', 'Tyk integration error: There is no such key found'])(
      'marks the row EXPIRED when Tyk does not know the key (%s)',
      async (message) => {
        db.apiKey.findMany.mockResolvedValue([expiredRow()]);
        tyk.deleteKey.mockRejectedValue(new BadRequestException(message));
        db.apiKey.update.mockResolvedValue(expiredRow({ status: ApiKeyStatus.EXPIRED }));

        await expect(service.checkExpired()).resolves.toBe(1);
        expect(db.apiKey.update).toHaveBeenCalledTimes(1);
      },
    );

    it('leaves the key ACTIVE when the gateway may still hold it, and keeps going with the others', async () => {
      db.apiKey.findMany.mockResolvedValue([expiredRow({ id: 'key-bad' }), expiredRow({ id: 'key-ok' })]);
      tyk.deleteKey.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(undefined);
      db.apiKey.update.mockResolvedValue(expiredRow({ status: ApiKeyStatus.EXPIRED }));

      await expect(service.checkExpired()).resolves.toBe(1);
      expect(db.apiKey.update).toHaveBeenCalledTimes(1);
      expect(db.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'key-ok' },
        data: { status: ApiKeyStatus.EXPIRED },
      });
    });
  });

  describe('getUsage', () => {
    // 14:37:30 is deliberately not on an hour boundary, so a floored and an exact bound differ.
    const USAGE_NOW = new Date('2026-09-19T14:37:30.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ now: USAGE_NOW, doNotFake: ['nextTick', 'queueMicrotask'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('404s for a key of another tenant before running any query', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ tenantId: OTHER_TENANT }));

      await expect(service.getUsage(KEY_ID, TENANT)).rejects.toThrow(NotFoundException);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns zeros when there is no traffic (no rows at all, or an all-null aggregate row)', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));

      db.$queryRaw.mockResolvedValueOnce([]);
      const none = await service.getUsage(KEY_ID, TENANT);
      db.$queryRaw.mockResolvedValueOnce([{ requests: 0n, errors: 0n, avg_latency_ms: null }]);
      const nulls = await service.getUsage(KEY_ID, TENANT, '7d');

      expect(none).toEqual({
        range: '24h',
        requests: 0,
        errors: 0,
        errorRate: 0,
        avgLatencyMs: 0,
        quotaMax: null,
        quotaRemaining: null,
        quotaResetAt: null,
      });
      expect(nulls).toMatchObject({ range: '7d', requests: 0, errorRate: 0, avgLatencyMs: 0 });
    });

    it('rolls up the key hash over the requested range and merges the live quota from Tyk', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      // The builder's bigint / numeric casts reach the service as BigInt and Decimal, not number.
      db.$queryRaw.mockResolvedValue([{ requests: 40n, errors: 5n, avg_latency_ms: new Prisma.Decimal('175.456') }]);
      tyk.getKey.mockResolvedValue(tykState);

      const usage = await service.getUsage(KEY_ID, TENANT, '24h');

      expect(usage).toEqual({
        range: '24h',
        requests: 40,
        errors: 5,
        errorRate: 12.5,
        avgLatencyMs: 175.46,
        quotaMax: 1000,
        quotaRemaining: 640,
        quotaResetAt: new Date(1_800_003_600 * 1000),
      });
    });

    // /keys/:id/usage and /analytics/keys must agree for the same key, so the service reads through the
    // analytics window and key-rollup builder instead of keeping a query of its own.
    it.each(['1h', '24h', '7d', '30d'] as const)(
      'runs the analytics key-rollup query for the %s window, scoped to the key own hash',
      async (range) => {
        db.apiKey.findUnique.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));
        db.$queryRaw.mockResolvedValue([]);

        await service.getUsage(KEY_ID, TENANT, range);

        const [sql] = db.$queryRaw.mock.calls[0] as [Prisma.Sql];
        const expected = keyRollupQuery(analyticsWindow(range, USAGE_NOW), [HASH]);
        expect(sql.text).toBe(expected.text);
        expect(sql.values).toEqual(expected.values);
        expect(sql.values).toContainEqual([HASH]);
      },
    );

    it('reads 1h from the raw table over the exact window and longer ranges from the hour-floored aggregate', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));
      db.$queryRaw.mockResolvedValue([]);

      await service.getUsage(KEY_ID, TENANT, '1h');
      await service.getUsage(KEY_ID, TENANT, '24h');

      const [raw, aggregate] = db.$queryRaw.mock.calls.map((call) => (call as [Prisma.Sql])[0]);
      expect(raw.text).toContain('public.tyk_analytics');
      expect(raw.values).toContainEqual(new Date('2026-09-19T13:37:30.000Z'));
      expect(aggregate.text).toContain('public.tyk_aggregated');
      expect(aggregate.values).toContain(Date.parse('2026-09-18T14:00:00.000Z') / 1000);
    });

    it('reports no quota when the key has none, and nulls when the gateway is unreachable', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow());
      db.$queryRaw.mockResolvedValue([{ requests: 3n, errors: 0n, avg_latency_ms: new Prisma.Decimal(10) }]);

      tyk.getKey.mockResolvedValueOnce({ ...tykState, quota_max: 0 });
      expect(await service.getUsage(KEY_ID, TENANT)).toMatchObject({ requests: 3, quotaMax: null, quotaRemaining: null });

      tyk.getKey.mockRejectedValueOnce(new TypeError('fetch failed'));
      expect(await service.getUsage(KEY_ID, TENANT)).toMatchObject({ requests: 3, quotaMax: null, quotaResetAt: null });
    });

    it('degrades to zeros while the pump tables do not exist yet, but surfaces other database errors', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ status: ApiKeyStatus.REVOKED }));

      db.$queryRaw.mockRejectedValueOnce(missingTable());
      await expect(service.getUsage(KEY_ID, TENANT)).resolves.toMatchObject({ requests: 0, errors: 0 });

      db.$queryRaw.mockRejectedValueOnce(new Error('connection lost'));
      await expect(service.getUsage(KEY_ID, TENANT)).rejects.toThrow('connection lost');
    });

    it('skips the query for a key that has no Tyk hash', async () => {
      db.apiKey.findUnique.mockResolvedValue(keyRow({ tykKeyId: null }));

      await expect(service.getUsage(KEY_ID, TENANT)).resolves.toMatchObject({ requests: 0 });
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
