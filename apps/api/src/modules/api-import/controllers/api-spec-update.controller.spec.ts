import 'reflect-metadata';
import {
  Body,
  Controller,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Patch,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { ApiImportModule } from '../api-import.module';
import { ApiImportService } from '../services/api-import.service';
import { SpecSourceService } from '../services/spec-source.service';
import { SpecUpdateService } from '../services/spec-update.service';
import { ApiImportController } from './api-import.controller';
import { ApiSpecUpdateController } from './api-spec-update.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {}, Prisma: {} }));

const API_ID = '3f1f7a7e-0a53-4a43-9d7e-2b0c1a4c9e11';

describe('ApiSpecUpdateController wiring', () => {
  const handler = (name: string): (() => unknown) =>
    (ApiSpecUpdateController.prototype as unknown as Record<string, () => unknown>)[name] as () => unknown;

  it('has exactly two routes, both api:update; only the apply is audited', () => {
    expect(Object.getOwnPropertyNames(ApiSpecUpdateController.prototype).filter((n) => n !== 'constructor').sort()).toEqual([
      'preview',
      'update',
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler('update'))).toEqual(['api:update']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler('preview'))).toEqual(['api:update']);
    expect(Reflect.getMetadata(AUDIT_KEY, handler('update'))).toBeDefined();
    expect(Reflect.getMetadata(AUDIT_KEY, handler('preview'))).toBeUndefined();
  });

  it('is guarded by tenant isolation and permissions on the whole controller', () => {
    expect(Reflect.getMetadata('__guards__', ApiSpecUpdateController)).toEqual(
      expect.arrayContaining([TenantIsolationGuard, PermissionsGuard]),
    );
  });
});

/** Routes that must keep the app's normal JSON parsing next to the raw-document ones. */
@Controller('apis')
class JsonEchoController {
  @Patch(':id')
  patch(@Body() body: unknown): { body: unknown } {
    return { body };
  }

  @Post(':id/sync')
  sync(@Body() body: unknown): { body: unknown } {
    return { body };
  }

  @Patch(':id/endpoints')
  endpoints(@Body() body: unknown): { body: unknown } {
    return { body };
  }
}

/** The real controller and the REAL `ApiImportModule.configure()` middleware scoping. */
@Module({
  controllers: [ApiSpecUpdateController, ApiImportController, JsonEchoController],
  providers: [
    { provide: SpecUpdateService, useValue: { update: jest.fn() } },
    { provide: ApiImportService, useValue: { import: jest.fn(), preview: jest.fn() } },
    { provide: SpecSourceService, useValue: { fetchDocument: jest.fn(), assertCapacity: jest.fn(), createWatched: jest.fn() } },
  ],
})
class HarnessModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    ApiImportModule.prototype.configure.call(this, consumer);
  }
}

describe('POST /apis/:id/spec over HTTP (body scoping and query parsing)', () => {
  let app: INestApplication;
  let base: string;
  let update: jest.Mock;
  let importer: { import: jest.Mock; preview: jest.Mock };
  let sources: { fetchDocument: jest.Mock };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HarnessModule] })
      .overrideGuard(TenantIsolationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    // The same pipe and prefix as main.ts: implicit conversion is what makes `dryRun=false` a trap.
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
    update = moduleRef.get<{ update: jest.Mock }>(SpecUpdateService).update;
    importer = moduleRef.get<{ import: jest.Mock; preview: jest.Mock }>(ApiImportService);
    sources = moduleRef.get<{ fetchDocument: jest.Mock }>(SpecSourceService);
  });

  const firstCall = (): unknown[] => (update.mock.calls as unknown[][])[0] ?? [];

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    update.mockReset().mockResolvedValue({ applied: false });
    importer.import.mockReset().mockResolvedValue({});
    importer.preview.mockReset().mockResolvedValue({});
    sources.fetchDocument.mockReset().mockResolvedValue({ kind: 'OK', text: 'openapi: 3.0.3\n', etag: null, lastModified: null });
  });

  const post = (query: string, body: string, type = 'application/yaml', route = 'spec'): Promise<Response> =>
    fetch(`${base}/apis/${API_ID}/${route}?${query}`, { method: 'POST', headers: { 'content-type': type }, body });

  it('apply: hands the raw YAML text to the service, with the parsed options', async () => {
    const yaml = 'openapi: 3.0.3\ninfo: {title: x}\n';
    const res = await post('expectedVersion=3&acknowledgeRemoved=true', yaml);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(yaml, undefined, API_ID, { dryRun: false, expectedVersion: 3, acknowledgeRemoved: true });
  });

  it('preview: same body parsing, dryRun forced on, expectedVersion 0 accepted', async () => {
    const yaml = 'openapi: 3.0.3\n';
    const res = await post('expectedVersion=0', yaml, 'application/yaml', 'spec/preview');

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(yaml, undefined, API_ID, { dryRun: true, expectedVersion: 0, acknowledgeRemoved: false });
  });

  it.each([
    ['apply with the removed dryRun flag', 'spec', 'expectedVersion=1&dryRun=true'],
    ['preview with acknowledgeRemoved', 'spec/preview', 'expectedVersion=1&acknowledgeRemoved=true'],
    ['preview without expectedVersion', 'spec/preview', ''],
    ['a negative expectedVersion', 'spec', 'expectedVersion=-1'],
  ])('answers 400 for %s', async (_label, route, query) => {
    expect((await post(query, 'x', 'application/yaml', route)).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['POST /apis/:id/spec', `/apis/${API_ID}/spec?expectedVersion=1`],
    ['POST /apis/:id/spec/preview', `/apis/${API_ID}/spec/preview?expectedVersion=1`],
    ['POST /apis/import', '/apis/import'],
    ['POST /apis/import/preview', '/apis/import/preview'],
  ])('%s refuses an application/json body with 415 OAS_IMPORT_WRONG_CONTENT_TYPE', async (_label, path) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openapi: '3.0.3' }),
    });

    expect(res.status).toBe(415);
    expect(JSON.stringify(await res.json())).toContain('OAS_IMPORT_WRONG_CONTENT_TYPE');
    expect(update).not.toHaveBeenCalled();
    expect(importer.import).not.toHaveBeenCalled();
    expect(importer.preview).not.toHaveBeenCalled();
  });

  it('the import routes still take text: a JSON document sent as text/plain reaches the service', async () => {
    const res = await fetch(`${base}/apis/import`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"openapi":"3.0.3"}' });

    expect(res.status).toBe(201);
    expect((importer.import.mock.calls as unknown[][])[0]?.[0]).toBe('{"openapi":"3.0.3"}');
  });

  // application/json is the 415 case below: Nest's app-wide JSON parser runs before any route-scoped middleware.
  it.each(['text/plain', 'application/x-yaml', 'application/octet-stream'])('reads the body as text when the content type is %s', async (type) => {
    await post('expectedVersion=1', '{"openapi":"3.0.3"}', type);
    expect(firstCall()[0]).toBe('{"openapi":"3.0.3"}');
  });

  it('parses acknowledgeRemoved=false as false, not as Boolean("false")', async () => {
    await post('expectedVersion=1&acknowledgeRemoved=false', 'x');

    expect(firstCall()[3]).toEqual({ dryRun: false, expectedVersion: 1, acknowledgeRemoved: false });
  });

  it('defaults acknowledgeRemoved to false', async () => {
    await post('expectedVersion=1', 'x');

    expect(firstCall()[3]).toEqual({ dryRun: false, expectedVersion: 1, acknowledgeRemoved: false });
  });

  it.each([
    ['a missing expectedVersion', ''],
    ['a non-numeric expectedVersion', 'expectedVersion=abc'],
    ['a non-integer expectedVersion', 'expectedVersion=1.5'],
    ['acknowledgeRemoved=yes', 'expectedVersion=1&acknowledgeRemoved=yes'],
    ['an unknown query field', 'expectedVersion=1&force=true'],
  ])('answers 400 for %s and never calls the service', async (_label, query) => {
    const res = await post(query, 'x');

    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a non-UUID id with 400', async () => {
    const res = await fetch(`${base}/apis/not-a-uuid/spec?expectedVersion=1`, { method: 'POST', body: 'x' });

    expect(res.status).toBe(400);
  });

  // OAS-08: the URL routes take a JSON body; the raw-document middleware scoped to `apis/import` must not swallow it.
  it.each([
    ['POST /apis/import/url/preview', '/apis/import/url/preview', 200],
    ['POST /apis/import/url', '/apis/import/url', 201],
  ])('%s parses its JSON body and fetches through the spec source service', async (_label, path, status) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://specs.example.com/openapi.json?token=t', serverIndex: 0 }),
    });

    expect(res.status).toBe(status);
    expect(sources.fetchDocument).toHaveBeenCalledWith('https://specs.example.com/openapi.json?token=t');
    const call = ((status === 200 ? importer.preview : importer.import).mock.calls as unknown[][])[0];
    expect(call).toEqual(['openapi: 3.0.3\n', undefined, { slug: undefined, serverIndex: 0 }]);
  });

  it.each([
    ['no url', {}],
    ['an unknown field', { url: 'https://h/x', force: true }],
    ['a bad interval', { url: 'https://h/x', watch: true, intervalMinutes: 5 }],
  ])('POST /apis/import/url answers 400 for %s', async (_label, body) => {
    const res = await fetch(`${base}/apis/import/url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect(res.status).toBe(400);
    expect(sources.fetchDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['PATCH', `/apis/${API_ID}`],
    ['POST', `/apis/${API_ID}/sync`],
    ['PATCH', `/apis/${API_ID}/endpoints`],
  ])('leaves %s %s on the normal JSON parser', async (method, path) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'kept' }),
    });

    expect(res.status).toBeLessThan(300);
    expect(await res.json()).toEqual({ body: { name: 'kept' } });
  });
});
