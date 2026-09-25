import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnprocessableEntityException } from '@nestjs/common';
import { Spectral } from '@stoplight/spectral-core';
import { ApiImportService } from './api-import.service';
import { SpectralLintService } from './spectral-lint.service';
import type { ApiService } from '../../api-management/services/api.service';
import type { ApiSpecService } from './api-spec.service';

/**
 * OAS-00 — the import path must treat the uploaded document as DATA.
 *
 * Two hazards, both reachable with `api:create` through `POST /apis/import`:
 *  1. Spectral's default resolver follows `$ref: http(s)://…` and `$ref: file:…` while linting, so
 *     an uploaded document could make the API process fetch an arbitrary URL or read a local file.
 *  2. A few hundred bytes of YAML aliases expand exponentially during parsing (a 272-byte document
 *     with 7 nesting levels took ~3.8 s on the reference machine; the 8th level did not finish in
 *     25 s), which blocks the API's event loop.
 *
 * The lint service is REAL here (the assertions are about its behaviour); `ApiService` is the mock
 * and the probe for "creates nothing".
 */

const TENANT = 'tenant-1';

/** A structurally valid OAS 3.0 document whose only schema is `$ref: <ref>`. */
const specWithSchemaRef = (ref: string): string =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Orders API', version: '1.0.0' },
    servers: [{ url: 'https://backend.example.com/api' }],
    paths: {
      '/orders': {
        get: {
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } },
          },
        },
      },
    },
  });

/** Same shape, but the reference is local and points at a component that exists. */
const LOCAL_REF_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Orders API', version: '1.0.0' },
  servers: [{ url: 'https://backend.example.com/api' }],
  paths: {
    '/orders': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
  },
  components: { schemas: { Order: { type: 'object', properties: { id: { type: 'string' } } } } },
});

/** Classic "billion laughs": `levels` nesting levels, each an alias of the previous level ×9. */
function aliasBomb(levels: number): string {
  let yaml = `a: &a [${Array<string>(9).fill('"lol"').join(',')}]\n`;
  let previous = 'a';
  for (let i = 1; i < levels; i += 1) {
    const name = String.fromCharCode(97 + i);
    yaml += `${name}: &${name} [${Array<string>(9).fill(`*${previous}`).join(',')}]\n`;
    previous = name;
  }
  return yaml;
}

const SMALL_ALIAS_SPEC = `openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
servers:
  - url: https://backend.example.com/api
x-defaults: &defaults
  owner: platform
x-copy: *defaults
paths: {}
`;

const bodyOf = (error: unknown): { error: string; details: Record<string, string[]> } =>
  (error as UnprocessableEntityException).getResponse() as { error: string; details: Record<string, string[]> };

describe('OAS import safety (OAS-00)', () => {
  let apis: { create: jest.Mock };
  let specs: { conflicts: jest.Mock };
  let service: ApiImportService;
  let server: Server;
  let hits: string[];
  let port: number;

  beforeAll(async () => {
    hits = [];
    server = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end('{"type":"string"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    hits.length = 0;
    specs = { conflicts: jest.fn().mockResolvedValue({ slug: false, listenPath: false }) };
    apis = { create: jest.fn().mockImplementation((dto: unknown) => Promise.resolve({ id: 'api-1', ...(dto as object) })) };
    service = new ApiImportService(new SpectralLintService(), apis as unknown as ApiService, specs as unknown as ApiSpecService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('external $ref', () => {
    it('never contacts a host named by an http $ref, and rejects the document with 422', async () => {
      const error = await service.import(specWithSchemaRef(`http://127.0.0.1:${String(port)}/schema.json`), TENANT).catch((e: unknown) => e);

      expect(hits).toEqual([]);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(error).error).toBe('OAS_LINT_FAILED');
      expect(Object.keys(bodyOf(error).details)).toContain('og-no-external-ref');
      expect(apis.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a file: URL', 'file:///etc/hostname'],
      ['a relative path', '../../etc/hostname'],
      ['a sibling file', 'other.yaml#/components/schemas/X'],
      ['an https URL', 'https://example.invalid/schema.json'],
      ['a value with leading whitespace', ' http://127.0.0.1:1/schema.json'],
    ])('rejects %s without ever running the linter', async (_label, ref) => {
      const run = jest.spyOn(Spectral.prototype, 'run');

      const error = await service.import(specWithSchemaRef(ref), TENANT).catch((e: unknown) => e);

      expect(run).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(Object.keys(bodyOf(error).details)).toContain('og-no-external-ref');
      expect(apis.create).not.toHaveBeenCalled();
    });

    it('finds an external $ref hidden in an x- extension, a path item and an example', async () => {
      const spec = JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Orders API', version: '1.0.0' },
        servers: [{ url: 'https://backend.example.com/api' }],
        paths: { '/a': { $ref: 'http://127.0.0.1:1/path-item.yaml' } },
        'x-extra': { nested: [{ $ref: 'file:///etc/passwd' }] },
        components: { examples: { E: { value: { $ref: 'https://example.invalid/e.json' } } } },
      });

      const error = await service.import(spec, TENANT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(error).details['og-no-external-ref']).toHaveLength(3);
    });

    it('still imports a document whose references are all local', async () => {
      const result = await service.import(LOCAL_REF_SPEC, TENANT);

      expect(hits).toEqual([]);
      expect(apis.create).toHaveBeenCalledTimes(1);
      expect(result.findings.some((finding) => finding.code === 'og-no-external-ref')).toBe(false);
    });
  });

  describe('YAML alias expansion', () => {
    it('rejects an alias bomb quickly and explicitly, before it can be expanded', async () => {
      const started = Date.now();

      const error = await service.import(aliasBomb(6), TENANT).catch((e: unknown) => e);

      expect(Date.now() - started).toBeLessThan(500);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(error).error).toBe('OAS_IMPORT_UNSAFE_YAML');
      expect(apis.create).not.toHaveBeenCalled();
    });

    it('accepts a specification that uses a handful of aliases', async () => {
      const result = await service.import(SMALL_ALIAS_SPEC, TENANT);

      expect(apis.create).toHaveBeenCalledTimes(1);
      expect(result.api).toBeDefined();
    });
  });

  describe('YAML tags the parser cannot turn into JSON', () => {
    const head = "openapi: 3.0.3\ninfo: {title: t, version: '1'}\nservers: [{url: 'https://b.example.com'}]\npaths: {}\n";
    /** Measured on the pinned parser: only `!!binary` breaks it; every other tag parses and lints. */
    const EXOTIC: [string, string, 'linted' | '422 OAS_IMPORT_UNPARSEABLE'][] = [
      ['!!binary', 'x-blob: !!binary aGVsbG8=\n', '422 OAS_IMPORT_UNPARSEABLE'],
      ['!!timestamp', 'x-at: !!timestamp 2001-12-14t21:59:43.10-05:00\n', 'linted'],
      ['!!set', 'x-set: !!set {a, b}\n', 'linted'],
      ['!!omap', 'x-omap: !!omap [a: 1, b: 2]\n', 'linted'],
      ['an unknown local tag', 'x-foo: !foo bar\n', 'linted'],
      ['a merge key', 'x-base: &b {k: 1}\nx-derived:\n  <<: *b\n  j: 2\n', 'linted'],
    ];

    it('answers a !!binary scalar with 422 OAS_IMPORT_UNPARSEABLE on the import, never a raw TypeError', async () => {
      const error = await service.import(`${head}x-blob: !!binary aGVsbG8=\n`, TENANT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(error)).toMatchObject({ error: 'OAS_IMPORT_UNPARSEABLE', message: 'The document is not valid YAML or JSON' });
      expect(JSON.stringify(bodyOf(error))).not.toMatch(/replace|TypeError|is not a function/);
      expect(apis.create).not.toHaveBeenCalled();
    });

    it.each(EXOTIC)('%s: exactly the measured outcome, never a raw exception', async (_label, extra, expected) => {
      const outcome = await new SpectralLintService().lint(`${head}${extra}`).then(
        () => 'linted',
        (e: unknown) => (e instanceof UnprocessableEntityException ? `422 ${bodyOf(e).error}` : `THREW ${String(e)}`),
      );

      expect(outcome).toBe(expected);
    });

    it('a normal document still lints', async () => {
      await expect(new SpectralLintService().lint(head)).resolves.toMatchObject({ parsed: { openapi: '3.0.3' } });
    });
  });
});
