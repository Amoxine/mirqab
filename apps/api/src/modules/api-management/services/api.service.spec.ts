import 'reflect-metadata';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { CircuitBreakerOpenError } from '../../../common/circuit-breaker/circuit-breaker.types';
import { UpdateApiDto } from '../dto/update-api.dto';
import { CreateApiVersionDto } from '../dto/create-api-version.dto';
import type { OAuthClientService } from '../../oauth-clients/services/oauth-client.service';
import type { ReconcileService } from './reconcile.service';
import { ApiService, RetiredVersionException, toSyncError } from './api.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    // WP12c: every gateway write resolves the tenant's org through `loadTenantScope`.
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' }) },
    apiDefinition: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

type Fn = jest.Mock;
const db = prisma.apiDefinition as unknown as Record<
  'findFirst' | 'findUnique' | 'findMany' | 'count' | 'create' | 'update' | 'delete',
  Fn
>;

const TENANT = 'tenant-1';
const ID = '11111111-1111-1111-1111-111111111111';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    tenantId: TENANT,
    name: 'Orders',
    slug: 'orders',
    tykApiId: 'og-11111111',
    proxyUrl: 'http://orders:4000',
    listenPath: '/orders/',
    authType: 'AUTH_TOKEN',
    status: 'ACTIVE',
    config: {},
    syncStatus: 'SYNCED',
    syncError: null,
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    parentApiId: null,
    versionName: null,
    retiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _count: { apiKeys: 0 },
    ...overrides,
  };
}

interface TykMock {
  createApi: Fn;
  updateApi: Fn;
  deleteApi: Fn;
  upsertPolicy: Fn;
  deletePolicy: Fn;
  upsertOasApi: Fn;
}

function setup() {
  const tyk: TykMock = {
    createApi: jest.fn().mockResolvedValue({ apiId: 'og-11111111' }),
    updateApi: jest.fn().mockResolvedValue({}),
    deleteApi: jest.fn().mockResolvedValue(undefined),
    upsertPolicy: jest.fn().mockResolvedValue(undefined),
    deletePolicy: jest.fn().mockResolvedValue(undefined),
    // WP16: createVersion/syncToTykWithNodes' OAS branch.
    upsertOasApi: jest.fn().mockResolvedValue([]),
  };
  // WP13a: both write paths now report per-node outcomes. Armed here rather than at the mock
  // declaration because `resetAllMocks()` in beforeEach wipes return values.
  tyk.createApi.mockResolvedValue({ apiId: 'og-11111111', nodes: [] });
  tyk.updateApi.mockResolvedValue({ nodes: [] });

  const oauthClients = { findByApi: jest.fn().mockResolvedValue([]) };
  // Drift is ReconcileService's job and has its own tests; ApiService only forwards to it.
  const reconcile = { reconcileOne: jest.fn().mockResolvedValue({ checkedAt: '', inSync: true, nodes: {} }) };
  return {
    tyk,
    oauthClients,
    reconcile,
    service: new ApiService(
      tyk as unknown as TykClientService,
      oauthClients as unknown as OAuthClientService,
      reconcile as unknown as ReconcileService,
    ),
  };
}

/** The Prisma args object of a mock's first call. */
interface CallArg {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  include: unknown;
  skip: number;
  take: number;
}
const firstArg = (fn: Fn): CallArg => (fn.mock.calls[0] as CallArg[])[0];

/** Let the fire-and-forget sync started by create()/update() settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ApiService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // Re-armed here because `resetAllMocks` clears return values: every gateway write resolves
    // the tenant's org through `loadTenantScope` (WP12c).
    (prisma.tenant.findUniqueOrThrow as jest.Mock).mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' });
  });

  describe('findOne', () => {
    it('scopes the lookup by tenant and 404s for another tenant', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(null);

      await expect(service.findOne(ID, 'other-tenant')).rejects.toBeInstanceOf(NotFoundException);
      expect(db.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ID, tenantId: 'other-tenant' } }),
      );
    });

    it('returns the ApiDetail shape with keyCount and without tenantId', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(
        row({ _count: { apiKeys: 3 }, config: { rateLimit: { rate: 5, per: 1 } } }),
      );

      const detail = await service.findOne(ID, TENANT);

      expect(detail.keyCount).toBe(3);
      expect(detail.config).toEqual({ rateLimit: { rate: 5, per: 1 } });
      expect(detail).not.toHaveProperty('tenantId');
      expect(detail).not.toHaveProperty('_count');
    });

    it('reads a missing or non-object config as an empty config', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ config: null }));
      expect((await service.findOne(ID, TENANT)).config).toEqual({});
    });

    it('answers a retired version with RetiredVersionException carrying the sunset date (WP16)', async () => {
      const { service } = setup();
      const retiredAt = new Date('2026-01-01T00:00:00Z');
      db.findFirst.mockResolvedValue(row({ status: 'RETIRED', retiredAt, name: 'Orders (v2)' }));

      await expect(service.findOne(ID, TENANT)).rejects.toBeInstanceOf(RetiredVersionException);

      try {
        await service.findOne(ID, TENANT);
        throw new Error('expected findOne to reject');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RetiredVersionException);
        const retired = err as RetiredVersionException;
        expect(retired.sunsetAt).toEqual(retiredAt);
        expect(retired.getStatus()).toBe(410);
      }
    });

    it('returns an ACTIVE (not RETIRED) version normally, even with parentApiId set', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ status: 'ACTIVE', parentApiId: 'default-1', versionName: 'v2' }));

      await expect(service.findOne(ID, TENANT)).resolves.toMatchObject({ status: 'ACTIVE', versionName: 'v2' });
    });
  });

  describe('findAll', () => {
    it('applies tenant, status, syncStatus and q filters and caps pageSize', async () => {
      const { service } = setup();
      db.findMany.mockResolvedValue([row()]);
      db.count.mockResolvedValue(1);

      const result = await service.findAll(TENANT, 0, 5000, 'ACTIVE', 'FAILED', ' ord ');

      const args = firstArg(db.findMany);
      expect(args.where).toMatchObject({ tenantId: TENANT, status: 'ACTIVE', syncStatus: 'FAILED' });
      expect(args.where.OR).toHaveLength(3);
      expect(JSON.stringify(args.where.OR)).toContain('"contains":"ord"');
      expect(args.take).toBe(100);
      expect(args.skip).toBe(0);
      expect(result.meta).toEqual({ page: 1, pageSize: 100, totalCount: 1, totalPages: 1 });
    });

    it('filters by tenant only when no filter is given', async () => {
      const { service } = setup();
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await service.findAll(TENANT);

      expect(firstArg(db.findMany).where).toEqual({ tenantId: TENANT });
    });
  });

  describe('update', () => {
    it('merges config sections, marks the API PENDING and never touches authType', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(
        row({ config: { rateLimit: { rate: 5, per: 1 }, doNotTrack: true } }),
      );
      db.update.mockResolvedValue(row({ syncStatus: 'PENDING' }));
      const dto = plainToInstance(UpdateApiDto, { config: { cors: null } });

      await service.update(ID, dto, TENANT);
      await flush();

      const data = firstArg(db.update).data;
      expect(data.config).toEqual({ rateLimit: { rate: 5, per: 1 }, doNotTrack: true, cors: null });
      expect(data.syncStatus).toBe('PENDING');
      expect(data).not.toHaveProperty('authType');
    });

    it('404s for another tenant before writing anything', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(null);

      await expect(service.update(ID, plainToInstance(UpdateApiDto, { name: 'x1' }), 'other')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.update).not.toHaveBeenCalled();
      expect(tyk.updateApi).not.toHaveBeenCalled();
    });

    it('409s on a slug that already exists in the tenant', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row());
      db.findUnique.mockResolvedValue(row({ id: 'other' }));

      await expect(service.update(ID, plainToInstance(UpdateApiDto, { slug: 'taken' }), TENANT)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(db.update).not.toHaveBeenCalled();
    });

    describe('retiring a version (WP16)', () => {
      it('refuses to retire the default (no parentApiId)', async () => {
        const { service } = setup();
        db.findFirst.mockResolvedValue(row({ parentApiId: null }));

        await expect(
          service.update(ID, plainToInstance(UpdateApiDto, { status: 'RETIRED' }), TENANT),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('stamps retiredAt when a child moves to RETIRED, and re-syncs the default', async () => {
        const { service, tyk } = setup();
        db.findFirst.mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2' }));
        db.update.mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2', status: 'RETIRED' }));
        // resyncParent's own fetch + its sibling query — defFormat: 'OAS' so it actually exercises
        // mapToTykOas/upsertOasApi rather than falling through to the classic path.
        db.findUnique.mockResolvedValue(row({ parentApiId: null, versionName: 'v1', defFormat: 'OAS' }));
        db.findMany.mockResolvedValue([]);

        await service.update('child-1', plainToInstance(UpdateApiDto, { status: 'RETIRED' }), TENANT);
        await flush();

        const data = firstArg(db.update).data;
        expect(data.status).toBe('RETIRED');
        expect(data.retiredAt).toBeInstanceOf(Date);
        // resyncParent re-fetches and re-pushes the DEFAULT, not the child that was just patched.
        expect(db.findUnique).toHaveBeenCalledWith({ where: { id: ID } });
        // The now-retired child excluded itself (db.findMany's own `where` filters `status: {not: RETIRED}`
        // at the query level, so an empty mock return here already proves it dropped out).
        expect(tyk.upsertOasApi).toHaveBeenCalled();
        const pushed = (tyk.upsertOasApi.mock.calls[0] as Record<string, unknown>[])[0];
        expect(pushed).toHaveProperty('x-tyk-api-gateway');
      });

      it('clears retiredAt when a version moves back off RETIRED', async () => {
        const { service } = setup();
        db.findFirst.mockResolvedValue(
          row({ id: 'child-1', parentApiId: ID, versionName: 'v2', status: 'RETIRED', retiredAt: new Date(0) }),
        );
        db.update.mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2', status: 'ACTIVE' }));
        db.findUnique.mockResolvedValue(row({ parentApiId: null, versionName: 'v1' }));
        db.findMany.mockResolvedValue([]);

        await service.update('child-1', plainToInstance(UpdateApiDto, { status: 'ACTIVE' }), TENANT);
        await flush();

        expect(firstArg(db.update).data).toMatchObject({ status: 'ACTIVE', retiredAt: null });
      });
    });
  });

  describe('createVersion (WP16)', () => {
    const versionDto = plainToInstance(CreateApiVersionDto, {
      versionName: 'v2',
      proxyUrl: 'http://orders-v2:4000',
    });

    it('refuses on a CLASSIC-format API', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ parentApiId: null, defFormat: 'CLASSIC' }));

      await expect(service.createVersion(ID, versionDto, TENANT)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.create).not.toHaveBeenCalled();
    });

    it('refuses to create a version of a version', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ parentApiId: 'some-other-default', defFormat: 'OAS' }));

      await expect(service.createVersion(ID, versionDto, TENANT)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.create).not.toHaveBeenCalled();
    });

    it('refuses authType: JWT with no jwt config, same O3 guard as create/update', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ parentApiId: null, defFormat: 'OAS' }));
      const jwtDto = plainToInstance(CreateApiVersionDto, {
        versionName: 'v2',
        proxyUrl: 'http://orders-v2:4000',
        authType: 'JWT',
      });

      await expect(service.createVersion(ID, jwtDto, TENANT)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.create).not.toHaveBeenCalled();
    });

    it('creates the child with a derived slug/listenPath, defaults the parent to v1, and syncs both', async () => {
      const { service, tyk } = setup();
      const parent = row({ id: ID, parentApiId: null, versionName: null, slug: 'orders', listenPath: '/orders/', defFormat: 'OAS' });
      db.findFirst
        .mockResolvedValueOnce(parent) // the parent lookup at the top of createVersion
        .mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2', defFormat: 'OAS' })); // the final re-read
      db.create.mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2', defFormat: 'OAS' }));
      db.update.mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2', defFormat: 'OAS' }));
      db.findUnique.mockResolvedValue(row({ id: ID, parentApiId: null, versionName: 'v1', defFormat: 'OAS' }));
      db.findMany.mockResolvedValue([{ versionName: 'v2', tykApiId: 'og-11111111' }]);

      const detail = await service.createVersion(ID, versionDto, TENANT);
      await flush();

      expect(firstArg(db.create).data).toMatchObject({
        parentApiId: ID,
        versionName: 'v2',
        slug: 'orders-v2',
        listenPath: '/orders/__version-v2',
        proxyUrl: 'http://orders-v2:4000',
        defFormat: 'OAS',
      });
      // The parent had no versionName yet — createVersion assigns the default's own.
      expect(db.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ID }, data: { versionName: 'v1' } }),
      );
      expect(detail.id).toBe('child-1');
      expect(tyk.upsertOasApi).toHaveBeenCalled();
    });
  });

  describe('JWT bring-your-own JWKS (O3)', () => {
    const jwtDto = {
      name: 'Orders',
      slug: 'orders',
      proxyUrl: 'http://orders:4000',
      listenPath: '/orders/',
      authType: 'JWT' as const,
    };
    const jwtConfig = { jwt: { jwksUrl: 'https://idp.example.com/jwks.json', issuer: 'https://idp.example.com/' } };

    it('refuses to create an authType: JWT api with no jwt config — the O3 fix for the old always-403 bug', async () => {
      const { service, tyk } = setup();

      await expect(service.create(jwtDto, TENANT)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.create).not.toHaveBeenCalled();
      expect(tyk.createApi).not.toHaveBeenCalled();
    });

    it('creates a JWT api with a jwt config and syncs its policy after the definition', async () => {
      const { service, tyk } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue(null);
      db.create.mockResolvedValue(row({ authType: 'JWT', config: jwtConfig, tykApiId: null }));
      db.update.mockResolvedValue(row({ authType: 'JWT', config: jwtConfig }));

      await service.create({ ...jwtDto, config: jwtConfig }, TENANT);
      await flush();

      expect(tyk.createApi).toHaveBeenCalledWith(
        expect.objectContaining({ jwt_source: jwtConfig.jwt.jwksUrl, jwt_default_policies: ['og-jwt-' + ID] }),
      );
      const policyArg = (tyk.upsertPolicy.mock.calls as Record<string, unknown>[][])[0][0];
      expect(policyArg.id).toBe('og-jwt-' + ID);
      expect(Object.keys(policyArg.access_rights as object)).toEqual(['og-11111111']);
    });

    it('refuses to switch an existing api to authType: JWT with no jwt config', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'AUTH_TOKEN', config: {} }));

      await expect(
        service.update(ID, plainToInstance(UpdateApiDto, { authType: 'JWT' }), TENANT),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('refuses a PATCH that clears jwt while authType stays JWT', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'JWT', config: jwtConfig }));

      await expect(
        service.update(ID, plainToInstance(UpdateApiDto, { config: { jwt: null } }), TENANT),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('allows an unrelated PATCH on an already-configured JWT api (effective config falls back to the stored row)', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'JWT', config: jwtConfig }));
      db.update.mockResolvedValue(row({ authType: 'JWT', config: jwtConfig, name: 'Orders 2' }));

      await service.update(ID, plainToInstance(UpdateApiDto, { name: 'Orders 2' }), TENANT);
      await flush();

      expect(db.update).toHaveBeenCalled();
    });

    it('best-effort deletes the JWT policy on remove, and does not fail the delete if that call errors', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'JWT', config: jwtConfig, _count: { apiKeys: 0 } }));
      tyk.deletePolicy.mockRejectedValue(new Error('gateway hiccup'));

      await expect(service.remove(ID, TENANT)).resolves.toEqual({ message: 'API deleted' });
      expect(tyk.deletePolicy).toHaveBeenCalledWith('og-jwt-' + ID);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('listen path uniqueness (per tenant, O10 — was global under B1)', () => {
    const dto = { name: 'Orders', slug: 'orders', proxyUrl: 'http://orders:4000', listenPath: '/orders/' };
    const p2002 = (target: string[]) =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.5.0',
        meta: { target },
      });

    it('409s on create when this tenant already owns the listen path', async () => {
      const { service, tyk } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue({ id: 'sibling-api' });

      const attempt = service.create(dto, TENANT);

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(/\/orders\/.*already used by another API in this tenant/);
      expect(db.create).not.toHaveBeenCalled();
      expect(tyk.createApi).not.toHaveBeenCalled();
    });

    // O10 reverses B1: the lookup MUST carry tenantId, or another tenant's identical path still
    // 409s and the squatting this WP removes comes straight back.
    it('scopes the clash lookup to this tenant, so another tenant may hold the same path', async () => {
      const { service } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue(null);
      db.create.mockResolvedValue(row());
      db.update.mockResolvedValue(row());

      await expect(service.create(dto, TENANT)).resolves.toMatchObject({ listenPath: '/orders/' });
      expect(firstArg(db.findFirst).where).toEqual({ listenPath: '/orders/', tenantId: TENANT });
      await flush();
    });

    it('creates the API when the listen path is free', async () => {
      const { service } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue(null);
      db.create.mockResolvedValue(row());
      db.update.mockResolvedValue(row());

      await expect(service.create(dto, TENANT)).resolves.toMatchObject({ listenPath: '/orders/' });
      await flush();
    });

    it('maps the P2002 that loses the race on create to 409, not 500', async () => {
      const { service } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue(null);
      db.create.mockRejectedValue(p2002(['listen_path']));

      const attempt = service.create(dto, TENANT);

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(/Listen path "\/orders\/"/);
    });

    it('maps a P2002 on the tenant+slug constraint to the slug conflict', async () => {
      const { service } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue(null);
      db.create.mockRejectedValue(p2002(['tenant_id', 'slug']));

      await expect(service.create(dto, TENANT)).rejects.toThrow(/slug "orders"/);
    });

    it('lets a non-P2002 database error surface unchanged', async () => {
      const { service } = setup();
      db.findUnique.mockResolvedValue(null);
      db.findFirst.mockResolvedValue(null);
      db.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(dto, TENANT)).rejects.toThrow('connection lost');
    });

    it('409s when an update moves an API onto a listen path someone else owns', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce({ id: 'other-api' });

      await expect(
        service.update(ID, plainToInstance(UpdateApiDto, { listenPath: '/taken/' }), TENANT),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('does not check the listen path when an update keeps it unchanged', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row());
      db.update.mockResolvedValue(row());

      await service.update(ID, plainToInstance(UpdateApiDto, { listenPath: '/orders/', name: 'Orders 2' }), TENANT);
      await flush();

      expect(db.findFirst).toHaveBeenCalledTimes(1);
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('409s deleting the default while versions exist, and the API is never touched (WP16)', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ parentApiId: null, versionName: 'v1' }));
      db.count.mockResolvedValue(2);

      const attempt = service.remove(ID, TENANT);

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(/2 version\(s\)/);
      expect(db.count).toHaveBeenCalledWith({ where: { parentApiId: ID } });
      expect(tyk.deleteApi).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('deletes a version (not the default) without the version-count guard, and re-syncs the default', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row({ id: 'child-1', parentApiId: ID, versionName: 'v2' }));
      db.delete.mockResolvedValue(row());
      db.findUnique.mockResolvedValue(row({ parentApiId: null, versionName: 'v1' }));
      db.findMany.mockResolvedValue([]);

      await expect(service.remove('child-1', TENANT)).resolves.toEqual({ message: 'API deleted' });
      await flush();

      expect(db.count).not.toHaveBeenCalled();
      expect(db.findUnique).toHaveBeenCalledWith({ where: { id: ID } });
    });

    it('refuses while OAuth2 clients still use the API', async () => {
      const { service, oauthClients, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'OAUTH', tykApiId: 'gw-1' }));
      oauthClients.findByApi.mockResolvedValue([{ clientId: 'c1' }, { clientId: 'c2' }]);

      // Hydra holds these, so `_count.apiKeys` cannot see them.
      await expect(service.remove(ID, TENANT)).rejects.toThrow(/2 OAuth2 client\(s\)/);
      expect(tyk.deleteApi).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('checks Hydra for orphaned clients even when the row is no longer OAUTH', async () => {
      // authType is patchable (UpdateApiDto extends PartialType(CreateApiDto)): flipping it away
      // from OAUTH first used to skip this check entirely, letting a client survive undetected —
      // findByApi filters by apiDefId, independent of the row's current authType, so it must always
      // run rather than only when authType currently reads 'OAUTH'.
      const { service, oauthClients } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'AUTH_TOKEN' }));
      oauthClients.findByApi.mockResolvedValue([{ clientId: 'orphaned-1' }]);

      await expect(service.remove(ID, TENANT)).rejects.toThrow(/1 OAuth2 client\(s\)/);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('deletes cleanly when authType is not OAUTH and no client is orphaned', async () => {
      const { service, oauthClients } = setup();
      db.findFirst.mockResolvedValue(row({ authType: 'AUTH_TOKEN' }));
      oauthClients.findByApi.mockResolvedValue([]);
      db.delete.mockResolvedValue(row());

      await service.remove(ID, TENANT);

      expect(oauthClients.findByApi).toHaveBeenCalledWith(ID, TENANT);
      expect(db.delete).toHaveBeenCalled();
    });

    it('refuses with 409 naming the count while ACTIVE keys exist, and deletes nothing', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ _count: { apiKeys: 2 } }));

      const attempt = service.remove(ID, TENANT);

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(/2 active key/);
      expect(tyk.deleteApi).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('counts only ACTIVE keys when looking up the row', async () => {
      const { service } = setup();
      db.findFirst.mockResolvedValue(row());
      db.delete.mockResolvedValue(row());

      await service.remove(ID, TENANT);

      const include = firstArg(db.findFirst).include;
      expect(include).toEqual({ _count: { select: { apiKeys: { where: { status: 'ACTIVE' } } } } });
    });

    it('deletes the Tyk definition and then the row when no ACTIVE key remains', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row());
      db.delete.mockResolvedValue(row());

      await expect(service.remove(ID, TENANT)).resolves.toEqual({ message: 'API deleted' });

      expect(tyk.deleteApi).toHaveBeenCalledWith('og-11111111');
      expect(db.delete).toHaveBeenCalledWith({ where: { id: ID } });
      expect(tyk.deleteApi.mock.invocationCallOrder[0]).toBeLessThan(db.delete.mock.invocationCallOrder[0]);
    });

    it('skips the gateway for an API that was never synced', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ tykApiId: null }));
      db.delete.mockResolvedValue(row());

      await service.remove(ID, TENANT);

      expect(tyk.deleteApi).not.toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('keeps the row and answers 502 when the gateway delete fails', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row());
      tyk.deleteApi.mockRejectedValue(new TypeError('fetch failed http://tyk-gateway:8080'));

      const attempt = service.remove(ID, TENANT);

      await expect(attempt).rejects.toBeInstanceOf(BadGatewayException);
      await expect(attempt).rejects.not.toThrow(/tyk-gateway/);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('syncNow', () => {
    it('records SYNCED, clears syncError and stamps lastSyncedAt on success', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ syncStatus: 'FAILED', syncError: 'old failure' }));
      db.update.mockResolvedValue(row({ syncStatus: 'SYNCED', lastSyncedAt: new Date(5) }));

      const detail = await service.syncNow(ID, TENANT);

      expect(tyk.updateApi).toHaveBeenCalledWith('og-11111111', expect.objectContaining({ api_id: 'og-11111111' }));
      const data = firstArg(db.update).data;
      expect(data).toMatchObject({ syncStatus: 'SYNCED', syncError: null, tykApiId: 'og-11111111' });
      expect(data.lastSyncedAt).toBeInstanceOf(Date);
      expect(detail.syncStatus).toBe('SYNCED');
    });

    it('creates the definition when the API has no tykApiId yet', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row({ tykApiId: null }));
      db.update.mockResolvedValue(row());

      await service.syncNow(ID, TENANT);

      expect(tyk.createApi).toHaveBeenCalled();
      expect(tyk.updateApi).not.toHaveBeenCalled();
      expect(firstArg(db.update).data.tykApiId).toBe('og-11111111');
    });

    it('resolves (never rejects) on a gateway failure and records FAILED with a sanitised syncError', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row());
      tyk.updateApi.mockRejectedValue(new BadRequestException('Tyk integration error: Api ID must be unique'));
      db.update.mockResolvedValue(row({ syncStatus: 'FAILED', syncError: 'Tyk integration error: Api ID must be unique' }));

      const detail = await service.syncNow(ID, TENANT);

      const data = firstArg(db.update).data;
      expect(data).toEqual({ syncStatus: 'FAILED', syncError: 'Tyk integration error: Api ID must be unique' });
      // lastSyncedAt is left alone: it keeps meaning "last time the gateway really had this definition".
      expect(data).not.toHaveProperty('lastSyncedAt');
      expect(detail.syncStatus).toBe('FAILED');
      expect(detail.syncError).toBe('Tyk integration error: Api ID must be unique');
    });

    it('hides network details when the gateway is unreachable', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(row());
      tyk.updateApi.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 172.18.0.5:8080') }));
      db.update.mockResolvedValue(row({ syncStatus: 'FAILED' }));

      await service.syncNow(ID, TENANT);

      expect(firstArg(db.update).data.syncError).toBe('Gateway unreachable');
    });

    it('404s for another tenant without calling the gateway', async () => {
      const { service, tyk } = setup();
      db.findFirst.mockResolvedValue(null);

      await expect(service.syncNow(ID, 'other')).rejects.toBeInstanceOf(NotFoundException);
      expect(tyk.updateApi).not.toHaveBeenCalled();
      expect(tyk.createApi).not.toHaveBeenCalled();
    });
  });

  describe('background sync after create/update', () => {
    it('records the failure on the row instead of surfacing it', async () => {
      const { service, tyk } = setup();
      db.findUnique.mockResolvedValue(null);
      const created = row({ tykApiId: null, syncStatus: 'PENDING' });
      db.create.mockResolvedValue(created);
      db.update.mockResolvedValue(row({ syncStatus: 'FAILED' }));
      tyk.createApi.mockRejectedValue(new TypeError('fetch failed'));

      const detail = await service.create(
        { name: 'Orders', slug: 'orders', proxyUrl: 'http://orders:4000', listenPath: '/orders/' },
        TENANT,
      );
      await flush();

      expect(detail.syncStatus).toBe('PENDING');
      expect(db.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { syncStatus: 'FAILED', syncError: 'Gateway unreachable' } }),
      );
    });
  });
});

describe('toSyncError', () => {
  it('passes a sanitised HttpException message through', () => {
    expect(toSyncError(new BadRequestException('Tyk integration error: boom'))).toBe('Tyk integration error: boom');
  });

  it('describes an open circuit without leaking its name', () => {
    expect(toSyncError(new CircuitBreakerOpenError('tyk', 30_000))).toBe('Gateway temporarily unavailable, retry shortly');
  });

  it('collapses unknown errors to a fixed string', () => {
    expect(toSyncError(new Error('getaddrinfo ENOTFOUND tyk-gateway'))).toBe('Gateway unreachable');
    expect(toSyncError('secret-value')).toBe('Gateway unreachable');
  });

  it('truncates to 500 characters', () => {
    expect(toSyncError(new BadRequestException('x'.repeat(2000)))).toHaveLength(500);
  });
});
