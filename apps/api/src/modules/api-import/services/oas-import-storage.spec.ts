import { createHash } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { ApiImportService } from './api-import.service';
import type { ApiSpecService } from './api-spec.service';
import { MAX_ENDPOINTS } from './oas-endpoints';
import { SpectralLintService } from './spectral-lint.service';
import type { ApiService } from '../../api-management/services/api.service';

/**
 * OAS-01: an import KEEPS the document and indexes its endpoints, and a preview reports what an
 * import would do without doing it. The lint service is real (the assertions are about its verdicts);
 * `ApiService` and `ApiSpecService` are the mocks and the probes for "writes nothing".
 */

const TENANT = 'tenant-1';

const SPEC = `# Orders service — kept verbatim, comments included
openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
servers:
  - url: https://backend.example.com/api
  - url: https://{env}.example.com/api
    variables:
      env:
        default: staging
  - url: http://localhost:9000
tags:
  - name: orders
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      tags: [orders]
      responses:
        '200':
          description: ok
    post:
      operationId: createOrder
      responses:
        '201':
          description: created
  /orders/{id}:
    get:
      operationId: getOrder
      deprecated: true
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
`;

const bodyOf = (error: unknown): { error: string; details: Record<string, string[]> } =>
  (error as UnprocessableEntityException).getResponse() as { error: string; details: Record<string, string[]> };

describe('OAS-01 — stored spec and preview', () => {
  let apis: { create: jest.Mock };
  let specs: { conflicts: jest.Mock };
  let service: ApiImportService;

  beforeEach(() => {
    apis = { create: jest.fn().mockImplementation((dto: unknown) => Promise.resolve({ id: 'api-1', ...(dto as object) })) };
    specs = { conflicts: jest.fn().mockResolvedValue({ slug: false, listenPath: false }) };
    service = new ApiImportService(new SpectralLintService(), apis as unknown as ApiService, specs as unknown as ApiSpecService);
  });

  describe('import', () => {
    it('hands the submitted text, its SHA-256 and the endpoint index to create()', async () => {
      const result = await service.import(SPEC, TENANT);

      const [, tenant, spec] = apis.create.mock.calls[0] as [unknown, string, Record<string, unknown>];
      expect(tenant).toBe(TENANT);
      expect(spec.sourceText).toBe(SPEC);
      expect(spec.contentHash).toBe(createHash('sha256').update(SPEC, 'utf8').digest('hex'));
      expect(spec).toMatchObject({ format: 'yaml', openapiVersion: '3.0.3', endpointCount: 3 });
      expect((spec.endpointIndex as { key: string }[]).map((e) => e.key)).toEqual(['listOrders', 'createOrder', 'getOrder']);
      expect(result.spec).toEqual({ versionNo: 1, contentHash: spec.contentHash, endpointCount: 3 });
    });

    it('takes the first server by default and expands server variables from their defaults', async () => {
      await service.import(SPEC, TENANT);
      expect((apis.create.mock.calls[0] as [{ proxyUrl: string }])[0].proxyUrl).toBe('https://backend.example.com/api');

      apis.create.mockClear();
      await service.import(SPEC, TENANT, { serverIndex: 1 });
      expect((apis.create.mock.calls[0] as [{ proxyUrl: string }])[0].proxyUrl).toBe('https://staging.example.com/api');
    });

    it('uses a slug override for the slug and the listen path', async () => {
      await service.import(SPEC, TENANT, { slug: 'orders-eu' });

      expect((apis.create.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ slug: 'orders-eu', listenPath: '/orders-eu/', name: 'Orders API' });
    });

    it.each([
      ['a slug that CreateApiDto refuses', { slug: 'Bad Slug!' }, 'derived:slug'],
      ['a serverIndex past the end of servers[]', { serverIndex: 9 }, 'derived:serverIndex'],
      ['a server the SSRF denylist refuses', { serverIndex: 2 }, 'derived:proxyUrl'],
    ])('rejects %s with 422 and creates nothing', async (_label, options, detailKey) => {
      const error = await service.import(SPEC, TENANT, options).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(error).error).toBe('OAS_IMPORT_UNUSABLE');
      expect(Object.keys(bodyOf(error).details)).toContain(detailKey);
      expect(apis.create).not.toHaveBeenCalled();
    });

    it('refuses a document with more operations than the endpoint limit, and creates nothing', async () => {
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < MAX_ENDPOINTS + 1; i += 1) paths[`/p${String(i)}`] = { get: { responses: { 200: { description: 'ok' } } } };
      const huge = {
        openapi: '3.0.3',
        info: { title: 'Huge', version: '1' },
        servers: [{ url: 'https://backend.example.com' }],
        paths,
      };
      // The real linter would spend seconds on 5001 operations; the linter's verdict is not what is under test.
      const lint = { lint: jest.fn().mockResolvedValue({ findings: [], hasErrors: false, parsed: huge }) };
      const capped = new ApiImportService(lint as unknown as SpectralLintService, apis as unknown as ApiService, specs as unknown as ApiSpecService);

      const error = await capped.import(JSON.stringify(huge), TENANT).catch((e: unknown) => e);

      expect(bodyOf(error).error).toBe('OAS_IMPORT_TOO_MANY_ENDPOINTS');
      expect(apis.create).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('reports the derived API, servers, endpoints and hash — and writes nothing', async () => {
      const preview = await service.preview(SPEC, TENANT);

      expect(apis.create).not.toHaveBeenCalled();
      expect(specs.conflicts).toHaveBeenCalledWith(TENANT, 'orders-api', '/orders-api/');
      expect(preview).toMatchObject({
        valid: true,
        canImport: true,
        openapiVersion: '3.0.3',
        format: 'yaml',
        derived: { name: 'Orders API', slug: 'orders-api', listenPath: '/orders-api/', proxyUrl: 'https://backend.example.com/api' },
        conflicts: { slug: false, listenPath: false },
        endpointCount: 3,
        problems: {},
      });
      expect(preview.contentHash).toBe(createHash('sha256').update(SPEC, 'utf8').digest('hex'));
      expect(preview.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /orders', 'POST /orders', 'GET /orders/{id}']);
      expect(preview.endpoints[2]).toMatchObject({ deprecated: true, key: 'getOrder' });
    });

    it('lists every server, marks the selected one and says why an unusable one is refused', async () => {
      const preview = await service.preview(SPEC, TENANT, { serverIndex: 1 });

      expect(preview.servers.map((s) => [s.index, s.url, s.selected])).toEqual([
        [0, 'https://backend.example.com/api', false],
        [1, 'https://staging.example.com/api', true],
        [2, 'http://localhost:9000', false],
      ]);
      expect(preview.servers[0]?.denyReason).toBeNull();
      expect(preview.servers[2]?.denyReason).toMatch(/not allowed/);
    });

    it('reports a conflict without failing: canImport is false but the document is still valid', async () => {
      specs.conflicts.mockResolvedValue({ slug: true, listenPath: false });

      const preview = await service.preview(SPEC, TENANT);

      expect(preview).toMatchObject({ valid: true, canImport: false, conflicts: { slug: true, listenPath: false } });
    });

    it('applies the same overrides as the real import', async () => {
      const preview = await service.preview(SPEC, TENANT, { slug: 'orders-eu', serverIndex: 1 });

      expect(preview.derived).toMatchObject({ slug: 'orders-eu', listenPath: '/orders-eu/', proxyUrl: 'https://staging.example.com/api' });
      expect(specs.conflicts).toHaveBeenCalledWith(TENANT, 'orders-eu', '/orders-eu/');
    });

    it('REPORTS lint errors (valid: false) instead of throwing, so a wizard can show what to fix', async () => {
      const broken = SPEC.replace('  version: 1.0.0\n', '');

      const preview = await service.preview(broken, TENANT);

      expect(preview.valid).toBe(false);
      expect(preview.canImport).toBe(false);
      expect(preview.findings.some((f) => f.severity === 'error')).toBe(true);
      expect(apis.create).not.toHaveBeenCalled();
    });

    it('REPORTS an unusable derived API (bad slug override, denied server) in `problems`', async () => {
      expect((await service.preview(SPEC, TENANT, { slug: 'Bad Slug!' })).problems).toHaveProperty(['derived:slug']);
      expect((await service.preview(SPEC, TENANT, { serverIndex: 2 })).problems).toHaveProperty(['derived:proxyUrl']);
      expect((await service.preview(SPEC, TENANT, { serverIndex: 9 })).problems).toHaveProperty(['derived:serverIndex']);
    });

    it('reports an external $ref as a lint error rather than following it', async () => {
      const spec = SPEC.replace(
        '          description: created\n',
        "          description: created\n          content:\n            application/json:\n              schema:\n                $ref: 'http://127.0.0.1:1/x.json'\n",
      );
      expect(spec).not.toBe(SPEC); // the substitution really happened — a no-op here would pass vacuously

      const preview = await service.preview(spec, TENANT);

      expect(preview.valid).toBe(false);
      expect(preview.findings.map((f) => f.code)).toContain('og-no-external-ref');
    });

    it.each([
      ['a document that is not JSON or YAML', ':\n  - [', 'OAS_IMPORT_UNPARSEABLE'],
      ['a Swagger 2.0 document', JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} }), 'OAS_IMPORT_UNSUPPORTED_VERSION'],
    ])('still FAILS for %s, exactly like the real import', async (_label, source, code) => {
      const error = await service.preview(source, TENANT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(error).error).toBe(code);
      expect(specs.conflicts).not.toHaveBeenCalled();
    });
  });
});
