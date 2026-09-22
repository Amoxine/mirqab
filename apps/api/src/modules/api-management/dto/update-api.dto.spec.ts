import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateApiDto } from './create-api.dto';
import { UpdateApiDto } from './update-api.dto';

describe('UpdateApiDto', () => {
  // Regression: a default on CreateApiDto.authType leaked into PartialType and reset auth to NONE on every PATCH.
  it('does not default authType on a partial update', () => {
    const dto = plainToInstance(UpdateApiDto, { status: 'ACTIVE' });
    expect(dto.authType).toBeUndefined();
  });

  it('keeps authType when provided', () => {
    const dto = plainToInstance(UpdateApiDto, { authType: 'AUTH_TOKEN' });
    expect(dto.authType).toBe('AUTH_TOKEN');
  });
});

describe('CreateApiDto.proxyUrl', () => {
  const check = async (proxyUrl: string) =>
    (await validate(plainToInstance(CreateApiDto, { name: 'x1', slug: 'x1', listenPath: '/x/', proxyUrl }))).filter(
      (e) => e.property === 'proxyUrl',
    );

  // Not `http://api:4000`: `api` is the platform's own compose service and is now denied.
  it.each(['http://my-backend:4000/api/health', 'http://10.0.0.5:3000', 'https://httpbin.org'])(
    'accepts %s',
    async (u) => {
      expect(await check(u)).toHaveLength(0);
    },
  );

  it.each(['api:4000', 'ftp://host/x', 'not a url'])('rejects %s', async (u) => {
    expect(await check(u)).toHaveLength(1);
  });

  // B2: loopback used to be accepted, which let a tenant proxy the platform's own ports.
  // Full table in proxy-url.validator.spec.ts.
  it.each(['http://localhost:3000', 'http://127.0.0.1:8080/tyk', 'http://169.254.169.254/'])(
    'rejects the denylisted upstream %s',
    async (u) => {
      expect(await check(u)).toHaveLength(1);
    },
  );
});
