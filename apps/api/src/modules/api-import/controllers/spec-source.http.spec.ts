import 'reflect-metadata';
import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { AuditLogInterceptor } from '../../audit/interceptors/audit-log.interceptor';
import { AuditService } from '../../audit/services/audit.service';
import { SpecCandidateService } from '../services/spec-candidate.service';
import { SpecSourceService } from '../services/spec-source.service';
import { SpecSourceController } from './spec-source.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {}, Prisma: {} }));

/**
 * OAS-08 routes over real HTTP: the SAME ValidationPipe options as main.ts and the REAL audit
 * interceptor (review LOW 8, H1, LOW 4). The services are test doubles; the audit write is captured.
 */

const API_ID = '3f1f7a7e-0a53-4a43-9d7e-2b0c1a4c9e11';

@Module({
  controllers: [SpecSourceController],
  providers: [
    { provide: SpecSourceService, useValue: { put: jest.fn() } },
    { provide: SpecCandidateService, useValue: {} },
    { provide: AuditService, useValue: { record: jest.fn() } },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class HarnessModule {}

describe('PUT /apis/:id/spec-source over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let put: jest.Mock;
  let record: jest.Mock;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HarnessModule] })
      .overrideGuard(TenantIsolationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
    put = moduleRef.get<{ put: jest.Mock }>(SpecSourceService).put;
    record = moduleRef.get<{ record: jest.Mock }>(AuditService).record;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    put.mockReset().mockResolvedValue({ configured: true });
    record.mockReset().mockResolvedValue(undefined);
  });

  const send = (body: unknown): Promise<Response> =>
    fetch(`${base}/apis/${API_ID}/spec-source`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  /** The audit write happens in a setImmediate after the response. */
  const audited = async (): Promise<string> => {
    for (let i = 0; i < 50 && record.mock.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(record).toHaveBeenCalledTimes(1);
    return JSON.stringify(record.mock.calls[0]);
  };

  it.each([
    ['an unknown field', { url: 'https://h.example/x', intervalMinutes: 60, force: true }],
    ['intervalMinutes 61', { url: 'https://h.example/x', intervalMinutes: 61 }],
    ['no intervalMinutes', { url: 'https://h.example/x' }],
    ['a url of 2049 characters', { url: `https://h.example/${'a'.repeat(2049 - 'https://h.example/'.length)}`, intervalMinutes: 60 }],
    ['an empty url', { url: '', intervalMinutes: 60 }],
    ['enabled "yes"', { intervalMinutes: 60, enabled: 'yes' }],
    // Implicit conversion would read "false" as Boolean("false") === true and ENABLE the source.
    ['enabled "false"', { intervalMinutes: 60, enabled: 'false' }],
  ])('400 for %s, the service is not called', async (_label, body) => {
    const res = await send(body);

    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it('a url of exactly 2048 characters passes the DTO', async () => {
    const url = `https://h.example/${'a'.repeat(2048 - 'https://h.example/'.length)}`;
    expect((await send({ url, intervalMinutes: 60 })).status).toBe(200);
  });

  it('a JSON boolean false stays false', async () => {
    expect((await send({ intervalMinutes: 60, enabled: false })).status).toBe(200);
    expect(put).toHaveBeenCalledWith(undefined, API_ID, { intervalMinutes: 60, enabled: false });
  });

  it('"60" is converted to 60', async () => {
    const res = await send({ intervalMinutes: '60' });

    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith(undefined, API_ID, { intervalMinutes: 60 });
  });

  it.each([
    [' https://h.example/x/t0kpath?token=S1'],
    ['\thttps://h.example/x/t0kpath?token=S2'],
    ['https:h.example/x/t0kpath?token=S3'],
    ['https:\\\\h.example\\x\\t0kpath?token=S4'],
  ])('the audit row keeps only the origin of %j (no token, no path)', async (url) => {
    expect((await send({ url, intervalMinutes: 60 })).status).toBe(200);

    const row = await audited();
    expect(row).not.toMatch(/token|S[1-4]|t0kpath/);
    expect(row).toContain('https://h.example/…');
  });
});
