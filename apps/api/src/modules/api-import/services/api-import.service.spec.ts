import { PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { ApiImportService, MAX_SPEC_BYTES, slugifyTitle } from './api-import.service';
import { SpectralLintService } from './spectral-lint.service';
import type { ApiService } from '../../api-management/services/api.service';

/**
 * WP24's two acceptance assertions, plus the size gate.
 *
 * The lint service is REAL here, not mocked — the assertions are about Spectral's verdict on a
 * document, so mocking it would assert nothing. `ApiService` is the mock, and it is also the probe:
 * "creates no ApiDefinition row" is asserted as "create() was never called", because create() is
 * the only path to that row (the service has no Prisma access of its own).
 */

const WARNING_ONLY_SPEC = `openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
servers:
  - url: https://backend.example.com/api
paths:
  /orders:
    get:
      responses:
        '200':
          description: ok
`;

/** Same document as JSON, to prove one parser serves both formats. */
const WARNING_ONLY_SPEC_JSON = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Orders API', version: '1.0.0' },
  servers: [{ url: 'https://backend.example.com/api' }],
  paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } } },
});

/** `info.version` is required by the OAS 3 meta-schema: `oas3-schema`, severity error. */
const ERROR_SPEC = `openapi: 3.0.3
info:
  title: Broken API
servers:
  - url: https://backend.example.com/api
paths: {}
`;

/** Relative server URL: valid OAS, unusable as an upstream. `og-server-url-absolute`, error. */
const RELATIVE_SERVER_SPEC = WARNING_ONLY_SPEC.replace('https://backend.example.com/api', '/v1');

/** No servers at all: `oas3-api-servers`, raised from warning to error by the repo ruleset. */
const NO_SERVER_SPEC = `openapi: 3.0.3
info:
  title: Serverless API
  version: 1.0.0
paths: {}
`;

const TENANT = 'tenant-1';

describe('ApiImportService', () => {
  let service: ApiImportService;
  let apis: { create: jest.Mock };

  beforeEach(() => {
    apis = { create: jest.fn().mockImplementation((dto: unknown) => Promise.resolve({ id: 'api-1', ...(dto as object) })) };
    service = new ApiImportService(new SpectralLintService(), apis as unknown as ApiService);
  });

  describe('assertion 1 — a warning-only spec creates the API and returns the findings', () => {
    it('creates the API and returns warnings', async () => {
      const result = await service.import(WARNING_ONLY_SPEC, TENANT);

      expect(apis.create).toHaveBeenCalledTimes(1);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings.every((f) => f.severity !== 'error')).toBe(true);
      // Warnings are real advice, not noise: the built-in oas ruleset flags the missing docs.
      expect(result.findings.map((f) => f.code)).toEqual(
        expect.arrayContaining(['info-contact', 'operation-operationId']),
      );
    });

    it('derives name, slug, listen path and upstream from the document', async () => {
      await service.import(WARNING_ONLY_SPEC, TENANT);

      expect(apis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Orders API',
          slug: 'orders-api',
          listenPath: '/orders-api/',
          proxyUrl: 'https://backend.example.com/api',
        }),
        TENANT,
      );
    });

    it('accepts the same document as JSON (one parser serves both formats)', async () => {
      const fromJson = await service.import(WARNING_ONLY_SPEC_JSON, TENANT);

      expect(apis.create).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'orders-api', proxyUrl: 'https://backend.example.com/api' }),
        TENANT,
      );
      expect(fromJson.findings.some((f) => f.severity === 'error')).toBe(false);
    });

    it('does not infer gateway auth from the document', async () => {
      await service.import(WARNING_ONLY_SPEC, TENANT);

      // authType stays unset so the row takes the schema default (NONE): a spec's securitySchemes
      // describe the UPSTREAM's expectations, not what the gateway should enforce.
      //
      // The assertion is on the VALUE, not the key: plainToInstance materialises every declared
      // optional property, so the DTO carries `authType: undefined`. That is the behaviour that
      // matters — Prisma omits an `undefined` field, which is what lets the schema default apply.
      const calls = apis.create.mock.calls as [Record<string, unknown>, string][];
      const [dto] = calls[0];
      expect(dto.authType).toBeUndefined();
    });
  });

  describe('assertion 2 — an error-severity finding returns 422, the findings, and creates nothing', () => {
    it.each([
      ['a schema violation', ERROR_SPEC, 'oas3-schema'],
      ['a relative server URL', RELATIVE_SERVER_SPEC, 'og-server-url-absolute'],
      ['no servers at all', NO_SERVER_SPEC, 'oas3-api-servers'],
    ])('rejects %s with 422 and creates no ApiDefinition', async (_label, spec, expectedCode) => {
      const error = await service.import(spec, TENANT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).getStatus()).toBe(422);

      // No row: create() is the only way to one, and it was never reached.
      expect(apis.create).not.toHaveBeenCalled();

      const body = (error as UnprocessableEntityException).getResponse() as {
        error: string;
        details: Record<string, string[]>;
      };
      expect(body.error).toBe('OAS_LINT_FAILED');
      expect(Object.keys(body.details)).toContain(expectedCode);
    });

    it('returns the warnings alongside the errors, so one pass shows everything', async () => {
      const error = (await service
        .import(RELATIVE_SERVER_SPEC, TENANT)
        .catch((e: unknown) => e)) as UnprocessableEntityException;

      const details = (error.getResponse() as { details: Record<string, string[]> }).details;
      expect(Object.keys(details)).toEqual(
        expect.arrayContaining(['og-server-url-absolute', 'info-contact']),
      );
    });

    it('rejects a Swagger 2.0 document, which the oas ruleset would otherwise pass', async () => {
      const swagger2 = JSON.stringify({
        swagger: '2.0',
        info: { title: 'Legacy', version: '1.0.0' },
        paths: {},
      });

      const error = (await service.import(swagger2, TENANT).catch((e: unknown) => e)) as UnprocessableEntityException;

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error.getResponse() as { error: string }).error).toBe('OAS_IMPORT_UNSUPPORTED_VERSION');
      expect(apis.create).not.toHaveBeenCalled();
    });

    it('rejects an upstream the SSRF denylist refuses, reusing CreateApiDto', async () => {
      // A structurally perfect spec whose only fault is where it points. The denylist is not
      // re-implemented here: it rides in through CreateApiDto's @IsAllowedProxyUrl.
      const spec = WARNING_ONLY_SPEC.replace('https://backend.example.com/api', 'http://tyk-gateway:8080');

      const error = (await service.import(spec, TENANT).catch((e: unknown) => e)) as UnprocessableEntityException;

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const body = error.getResponse() as { error: string; details: Record<string, string[]> };
      expect(body.error).toBe('OAS_IMPORT_UNUSABLE');
      expect(body.details['derived:proxyUrl'].join(' ')).toMatch(/platform itself/);
      expect(apis.create).not.toHaveBeenCalled();
    });
  });

  describe('size limit', () => {
    it('rejects a document over 5 MB with 413 and creates nothing', async () => {
      // Padded inside a description so the document stays valid YAML — the size gate must fire
      // before the lint gate, not because the payload happens to be malformed.
      const oversize = WARNING_ONLY_SPEC.replace(
        'description: ok',
        `description: ${'x'.repeat(MAX_SPEC_BYTES + 1)}`,
      );
      expect(Buffer.byteLength(oversize, 'utf8')).toBeGreaterThan(MAX_SPEC_BYTES);

      const error = await service.import(oversize, TENANT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PayloadTooLargeException);
      expect((error as PayloadTooLargeException).getStatus()).toBe(413);
      expect(apis.create).not.toHaveBeenCalled();
    });

    it('accepts a document just under the limit', async () => {
      const padding = MAX_SPEC_BYTES - Buffer.byteLength(WARNING_ONLY_SPEC, 'utf8') - 100;
      const large = WARNING_ONLY_SPEC.replace('description: ok', `description: ${'x'.repeat(padding)}`);
      expect(Buffer.byteLength(large, 'utf8')).toBeLessThan(MAX_SPEC_BYTES);

      await expect(service.import(large, TENANT)).resolves.toBeDefined();
      expect(apis.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('unparseable input', () => {
    it.each([
      ['empty body', ''],
      ['not a document', 'just a bare string'],
      ['broken YAML', 'openapi: 3.0.3\ninfo:\n  title: "unterminated\n'],
    ])('rejects %s without creating anything', async (_label, body) => {
      const error = await service.import(body, TENANT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(apis.create).not.toHaveBeenCalled();
    });
  });

  describe('slugifyTitle', () => {
    it.each([
      ['Orders API', 'orders-api'],
      ['  Payments  v2  ', 'payments-v2'],
      ['Café Münü', 'cafe-munu'],
      ['A---B', 'a-b'],
      ['!!!', ''],
    ])('slugifies %j to %j', (input, expected) => {
      expect(slugifyTitle(input.trim())).toBe(expected);
    });

    it('never leaves a trailing hyphen after truncation', () => {
      const slug = slugifyTitle(`${'a'.repeat(59)} tail`);
      expect(slug).not.toMatch(/-$/);
      expect(slug.length).toBeLessThanOrEqual(60);
    });
  });
});
