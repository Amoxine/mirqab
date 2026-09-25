import { type ConflictException, NotFoundException, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import * as Parsers from '@stoplight/spectral-parsers';
import { ApiImportService } from './api-import.service';
import type { ApiSpecService } from './api-spec.service';
import { buildEndpointIndex, contentHashOf } from './oas-endpoints';
import { SpectralLintService } from './spectral-lint.service';
import { SpecUpdateService, type SpecUpdateOptions } from './spec-update.service';
import type { ApiService } from '../../api-management/services/api.service';

jest.mock('@open-gateway/database', () => {
  class PrismaClientKnownRequestError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    prisma: {
      apiDefinition: { findFirst: jest.fn(), updateMany: jest.fn() },
      apiSpec: { findFirst: jest.fn(), create: jest.fn() },
      $transaction: jest.fn(),
    },
    Prisma: { PrismaClientKnownRequestError, AnyNull: 'AnyNull' },
  };
});

interface Mocked {
  prisma: {
    apiDefinition: { findFirst: jest.Mock; updateMany: jest.Mock };
    apiSpec: { findFirst: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
  };
  Prisma: { PrismaClientKnownRequestError: new (code: string) => Error };
}
const { prisma: db, Prisma: { PrismaClientKnownRequestError: FakeKnownRequestError } } = jest.requireMock<Mocked>('@open-gateway/database');

/**
 * OAS-04 service rules with the REAL import gate chain (lint, safety, parse, 3.x) and a Prisma mock
 * that records every write. The compare-and-set against a real Postgres is `spec-update.db-spec.ts`.
 */

const TENANT = 'tenant-a';
const API = 'api-1';

const doc = (paths: string): string =>
  [
    'openapi: 3.0.3',
    'info:',
    '  title: Orders API',
    '  version: 1.0.0',
    'servers:',
    '  - url: https://backend.example.com',
    'paths:',
    paths,
  ].join('\n');

const op = (id: string, extra = ''): string =>
  `      operationId: ${id}\n${extra}      responses:\n        '200':\n          description: ok\n`;

const V1 = doc(`  /orders:\n    get:\n${op('listOrders')}    post:\n${op('createOrder')}`);
/** listOrders gains a parameter; createOrder is gone; getOrder is new. */
const V2 = doc(
  `  /orders:\n    get:\n${op('listOrders', '      parameters:\n        - name: q\n          in: query\n          schema:\n            type: string\n')}` +
    `  /orders/{id}:\n    get:\n${op('getOrder', '      parameters:\n        - name: id\n          in: path\n          required: true\n          schema:\n            type: string\n')}`,
);

/** The same parser the gate chain uses, without the linter: only the stored index shape matters here. */
const indexOf = (source: string): unknown => buildEndpointIndex(Parsers.parseYaml(source).data).endpoints;

const OPTS: SpecUpdateOptions = { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false };

describe('SpecUpdateService', () => {
  let apis: { syncNow: jest.Mock };
  let service: SpecUpdateService;

  const stored = (config: unknown, source = V1, versionNo = 1): void => {
    db.apiDefinition.findFirst.mockResolvedValue({ config });
    db.apiSpec.findFirst.mockResolvedValue({ versionNo, contentHash: contentHashOf(source), endpointIndex: indexOf(source) });
  };
  const errorOf = (p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> =>
    p.then(
      () => ({ status: 0, body: {} }),
      (e: unknown) => ({
        status: (e as ConflictException).getStatus(),
        body: (e as ConflictException).getResponse() as Record<string, unknown>,
      }),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    db.apiSpec.create.mockResolvedValue({});
    db.apiDefinition.updateMany.mockResolvedValue({ count: 1 });
    apis = { syncNow: jest.fn().mockResolvedValue({}) };
    const specs = { conflicts: jest.fn().mockResolvedValue({ slug: false, listenPath: false }) };
    const importer = new ApiImportService(new SpectralLintService(), {} as ApiService, specs as unknown as ApiSpecService);
    service = new SpecUpdateService(importer, apis as unknown as ApiService);
  });

  it('scopes both reads to the tenant, and answers 404 for another tenant’s API', async () => {
    db.apiDefinition.findFirst.mockResolvedValue(null);

    await expect(service.update(V2, TENANT, API, OPTS)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.apiDefinition.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: API, tenantId: TENANT } }));
    expect(db.apiSpec.create).not.toHaveBeenCalled();
  });

  it('expectedVersion=0 attaches a first spec to an API that has none: version 1, everything added', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ config: { endpoints: { orphanKey: { enabled: false } } } });
    db.apiSpec.findFirst.mockResolvedValue(null);

    const preview = await service.update(V2, TENANT, API, { ...OPTS, dryRun: true, expectedVersion: 0 });
    expect(preview).toMatchObject({ applied: false, versionNo: 0, governanceImpact: { removedGoverned: [], changedGoverned: [] } });
    expect(preview.diff.added.map((row) => row.key)).toEqual(['listOrders', 'getOrder']);
    expect(db.apiSpec.create).not.toHaveBeenCalled();

    const applied = await service.update(V2, TENANT, API, { ...OPTS, expectedVersion: 0 });
    expect(applied).toMatchObject({ applied: true, versionNo: 1 });
    expect(db.apiSpec.create).toHaveBeenCalledWith({ data: expect.objectContaining({ versionNo: 1, tenantId: TENANT }) as unknown });
    expect(db.apiSpec.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT, apiDefId: API } }));
    expect(apis.syncNow).toHaveBeenCalledWith(API, TENANT);
  });

  it('409 for expectedVersion>0 on an API without a spec, and for expectedVersion=0 on an API with one', async () => {
    db.apiDefinition.findFirst.mockResolvedValue({ config: {} });
    db.apiSpec.findFirst.mockResolvedValue(null);
    expect(await errorOf(service.update(V2, TENANT, API, { ...OPTS, expectedVersion: 1 }))).toMatchObject({ status: 409, body: { error: 'SPEC_VERSION_STALE' } });

    stored({});
    expect(await errorOf(service.update(V2, TENANT, API, { ...OPTS, expectedVersion: 0 }))).toMatchObject({ status: 409, body: { error: 'SPEC_VERSION_STALE' } });
    expect(db.apiSpec.create).not.toHaveBeenCalled();
  });

  it('AC-04.1 identical bytes: unchanged, empty diff, nothing written, no sync — even with a stale version', async () => {
    stored({}, V1, 4);

    const result = await service.update(V1, TENANT, API, { ...OPTS, expectedVersion: 3 });

    expect(result).toMatchObject({ unchanged: true, applied: false, versionNo: 4, diff: { added: [], removed: [], changed: [] } });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(apis.syncNow).not.toHaveBeenCalled();
  });

  it('dry run: the diff and the governance impact, and nothing written', async () => {
    stored({ endpoints: { createOrder: { enabled: false }, listOrders: { auth: 'public' } } });

    const result = await service.update(V2, TENANT, API, { ...OPTS, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, applied: false, unchanged: false, versionNo: 1 });
    expect(result.diff.added.map((row) => row.key)).toEqual(['getOrder']);
    expect(result.diff.removed.map((row) => row.key)).toEqual(['createOrder']);
    expect(result.diff.changed.map((c) => [c.key, c.fields])).toEqual([['listOrders', ['fingerprint']]]);
    expect(result.governanceImpact).toEqual({
      removedGoverned: [{ key: 'createOrder', governance: { enabled: false } }],
      changedGoverned: ['listOrders'],
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(apis.syncNow).not.toHaveBeenCalled();
  });

  it('a stale expectedVersion is 409 SPEC_VERSION_STALE, dry run included', async () => {
    stored({}, V1, 2);

    for (const dryRun of [true, false]) {
      const { status, body } = await errorOf(service.update(V2, TENANT, API, { ...OPTS, dryRun, expectedVersion: 1 }));
      expect(status).toBe(409);
      expect(body.error).toBe('SPEC_VERSION_STALE');
    }
    expect(db.apiSpec.create).not.toHaveBeenCalled();
  });

  it('AC-04.4 refuses to drop a governed endpoint without acknowledgeRemoved, naming it', async () => {
    stored({ endpoints: { createOrder: { enabled: false } } });

    const { status, body } = await errorOf(service.update(V2, TENANT, API, OPTS));

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'SPEC_REMOVES_GOVERNED_ENDPOINTS', details: { removedGoverned: ['createOrder'] } });
    expect(db.apiSpec.create).not.toHaveBeenCalled();
  });

  it('applies version + 1 with acknowledgeRemoved, never writes config, marks PENDING, then resyncs', async () => {
    const config = { endpoints: { createOrder: { enabled: false }, listOrders: { auth: 'public' } }, cache: { enabled: true } };
    stored(config);

    const result = await service.update(V2, TENANT, API, { ...OPTS, acknowledgeRemoved: true });

    expect(result).toMatchObject({ applied: true, unchanged: false, versionNo: 2 });
    expect(db.apiSpec.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        apiDefId: API,
        versionNo: 2,
        sourceText: V2,
        contentHash: contentHashOf(V2),
        format: 'yaml',
        endpointCount: 2,
      }) as unknown,
    });
    // AC-04.3: the only API-row write is syncStatus, guarded by the config it was computed from.
    expect(db.apiDefinition.updateMany).toHaveBeenCalledWith({
      where: { id: API, tenantId: TENANT, config: { equals: config } },
      data: { syncStatus: 'PENDING' },
    });
    expect(apis.syncNow).toHaveBeenCalledWith(API, TENANT);
  });

  it('a stored index whose rows predate the fingerprint still diffs on index fields', async () => {
    stored({});
    const legacy = (indexOf(V1) as Record<string, unknown>[]).map(({ fingerprint: _f, ...row }) => row);
    db.apiSpec.findFirst.mockResolvedValue({ versionNo: 1, contentHash: 'old', endpointIndex: legacy });

    const result = await service.update(V2, TENANT, API, { ...OPTS, dryRun: true });

    expect(result.diff.changed).toEqual([]);
    expect(result.diff.added.map((r) => r.key)).toEqual(['getOrder']);
  });

  it('409 (never 500) when the version moved between the check and the insert', async () => {
    stored({});
    db.apiSpec.findFirst
      .mockResolvedValueOnce({ versionNo: 1, contentHash: contentHashOf(V1), endpointIndex: indexOf(V1) })
      .mockResolvedValueOnce({ versionNo: 2 });

    const { status, body } = await errorOf(service.update(V2, TENANT, API, OPTS));

    expect([status, body.error]).toEqual([409, 'SPEC_VERSION_STALE']);
    expect(db.apiSpec.create).not.toHaveBeenCalled();
  });

  it('maps the unique-version backstop (P2002) to 409, and passes other database errors through', async () => {
    stored({});
    db.apiSpec.create.mockRejectedValueOnce(new FakeKnownRequestError('P2002'));
    expect(await errorOf(service.update(V2, TENANT, API, OPTS))).toMatchObject({ status: 409, body: { error: 'SPEC_VERSION_STALE' } });

    db.apiSpec.create.mockRejectedValueOnce(new FakeKnownRequestError('P1001'));
    await expect(service.update(V2, TENANT, API, OPTS)).rejects.toBeInstanceOf(FakeKnownRequestError);
    expect(apis.syncNow).not.toHaveBeenCalled();
  });

  it('409 SPEC_GOVERNANCE_CHANGED when the config changed during the upload', async () => {
    stored({});
    db.apiDefinition.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await errorOf(service.update(V2, TENANT, API, OPTS))).toMatchObject({ status: 409, body: { error: 'SPEC_GOVERNANCE_CHANGED' } });
    expect(apis.syncNow).not.toHaveBeenCalled();
  });

  it('a gateway/database failure of the background resync does not fail the apply', async () => {
    stored({});
    apis.syncNow.mockRejectedValueOnce(new Error('db down'));

    await expect(service.update(V2, TENANT, API, OPTS)).resolves.toMatchObject({ applied: true });
  });

  describe('the same gates as the import', () => {
    beforeEach(() => {
      stored({});
    });

    it('lint errors are reported on a dry run and refused (422 OAS_LINT_FAILED) on apply', async () => {
      const broken = V2.replace('  version: 1.0.0\n', '');

      const dry = await service.update(broken, TENANT, API, { ...OPTS, dryRun: true });
      expect(dry.findings.some((f) => f.severity === 'error')).toBe(true);

      const { status, body } = await errorOf(service.update(broken, TENANT, API, OPTS));
      expect([status, body.error]).toEqual([422, 'OAS_LINT_FAILED']);
      expect(db.apiSpec.create).not.toHaveBeenCalled();
    });

    it('an external $ref is a lint error and is not followed', async () => {
      const withRef = V2.replace(
        "          description: ok\n",
        "          description: ok\n          content:\n            application/json:\n              schema:\n                $ref: 'http://127.0.0.1:1/x.json'\n",
      );
      expect(withRef).not.toBe(V2);

      const dry = await service.update(withRef, TENANT, API, { ...OPTS, dryRun: true });
      expect(dry.findings.map((f) => f.code)).toContain('og-no-external-ref');
      expect((await errorOf(service.update(withRef, TENANT, API, OPTS))).status).toBe(422);
    });

    it('a YAML alias bomb is refused before parsing', async () => {
      const bomb = `${V2}\nx-a: &a [1]\nx-b: [*a, *a, *a, *a, *a, *a]\n`;
      const { status, body } = await errorOf(service.update(bomb, TENANT, API, { ...OPTS, dryRun: true }));

      expect([status, body.error]).toEqual([422, 'OAS_IMPORT_UNSAFE_YAML']);
    });

    it('a document over 5 MB is 413', async () => {
      const big = V2.replace('description: ok', `description: ${'x'.repeat(5 * 1024 * 1024)}`);

      await expect(service.update(big, TENANT, API, { ...OPTS, dryRun: true })).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('Swagger 2.0 is refused', async () => {
      const swagger = JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} });
      const { body } = await errorOf(service.update(swagger, TENANT, API, { ...OPTS, dryRun: true }));

      expect(body.error).toBe('OAS_IMPORT_UNSUPPORTED_VERSION');
    });

    it('a document with more operations than the index cap is refused, not truncated', async () => {
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < 5001; i += 1) paths[`/p${String(i)}`] = { get: { responses: { 200: { description: 'ok' } } } };
      const huge = { openapi: '3.0.3', info: { title: 'Huge', version: '1' }, servers: [{ url: 'https://b.example.com' }], paths };
      const lint = { lint: jest.fn().mockResolvedValue({ findings: [], hasErrors: false, parsed: huge }) };
      const specs = { conflicts: jest.fn().mockResolvedValue({ slug: false, listenPath: false }) };
      const capped = new SpecUpdateService(
        new ApiImportService(lint as unknown as SpectralLintService, {} as ApiService, specs as unknown as ApiSpecService),
        apis as unknown as ApiService,
      );

      const { status, body } = await errorOf(capped.update(JSON.stringify(huge), TENANT, API, { ...OPTS, dryRun: true }));
      expect([status, body.error]).toEqual([422, 'OAS_IMPORT_TOO_MANY_ENDPOINTS']);
    });

    it('a !!binary scalar is a clean 422 OAS_IMPORT_UNPARSEABLE, not a 500', async () => {
      const { status, body } = await errorOf(service.update(`${V2}x-blob: !!binary aGVsbG8=\n`, TENANT, API, { ...OPTS, dryRun: true }));

      expect([status, body.error]).toEqual([422, 'OAS_IMPORT_UNPARSEABLE']);
    });

    it('an unparseable body is 422', async () => {
      await expect(service.update(':\n  - [', TENANT, API, { ...OPTS, dryRun: true })).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});
