import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateEndpointsDto } from './update-endpoints.dto';
import { UpdateApiDto } from './update-api.dto';
import { EDGE_BODY_LIMIT_BYTES } from './api-config.dto';

// Same options as main.ts — forbidNonWhitelisted is what makes an undecorated field a 400.
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const revision = 'a'.repeat(64);
const patch = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateEndpointsDto });

describe('UpdateEndpointsDto (PATCH /apis/:id/endpoints)', () => {
  it('accepts every offered control and keeps the values', async () => {
    const dto = (await patch({
      expectedRevision: revision,
      keys: ['getOrder'],
      set: {
        enabled: false,
        auth: 'public',
        rateLimit: { rate: 2, per: 10 },
        cache: { timeoutSeconds: 5, cacheResponseCodes: [200] },
        timeoutSeconds: 1,
        requestSizeLimitBytes: 10,
        mock: { code: 200, body: 'x', headers: [{ name: 'a', value: 'b' }] },
        validateRequestSchema: { type: 'object' },
      },
      clear: [],
      restrictToSpec: true,
      dropOrphans: true,
    })) as UpdateEndpointsDto;
    expect(dto.set?.enabled).toBe(false);
    expect(dto.set?.rateLimit).toEqual({ rate: 2, per: 10 });
    expect(dto.set?.validateRequestSchema).toEqual({ type: 'object' });
  });

  it('accepts the two clear spellings and a clear list', async () => {
    await expect(
      patch({ expectedRevision: revision, tag: 'orders', set: { enabled: true, auth: 'inherit' }, clear: ['rateLimit', 'mock'] }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['a missing revision', { keys: ['a'], set: { enabled: false } }],
    ['a short revision', { expectedRevision: 'abc', dropOrphans: true }],
    ['an upper-case revision', { expectedRevision: 'A'.repeat(64), dropOrphans: true }],
    ['an unknown top-level field', { expectedRevision: revision, dropOrphans: true, force: true }],
    ['an unknown control in set', { expectedRevision: revision, keys: ['a'], set: { circuitBreaker: {} } }],
    ['an unverified control name in clear', { expectedRevision: revision, keys: ['a'], clear: ['urlRewrite'] }],
    ['auth other than public/inherit', { expectedRevision: revision, keys: ['a'], set: { auth: 'none' } }],
    ['enabled as a string', { expectedRevision: revision, keys: ['a'], set: { enabled: 'false' } }],
    ['restrictToSpec as a string', { expectedRevision: revision, restrictToSpec: 'true' }],
    ['a rate of 0', { expectedRevision: revision, keys: ['a'], set: { rateLimit: { rate: 0, per: 60 } } }],
    ['a window over a day', { expectedRevision: revision, keys: ['a'], set: { rateLimit: { rate: 1, per: 86_401 } } }],
    ['an unknown rateLimit field', { expectedRevision: revision, keys: ['a'], set: { rateLimit: { rate: 1, per: 1, burst: 2 } } }],
    ['a timeout over 600 s', { expectedRevision: revision, keys: ['a'], set: { timeoutSeconds: 601 } }],
    ['a size limit above the edge', { expectedRevision: revision, keys: ['a'], set: { requestSizeLimitBytes: EDGE_BODY_LIMIT_BYTES + 1 } }],
    ['a cache code out of range', { expectedRevision: revision, keys: ['a'], set: { cache: { timeoutSeconds: 1, cacheResponseCodes: [99] } } }],
    ['a mock code out of range', { expectedRevision: revision, keys: ['a'], set: { mock: { code: 700, body: '' } } }],
    ['a schema that is not an object', { expectedRevision: revision, keys: ['a'], set: { validateRequestSchema: 'x' } }],
    ['an empty keys list', { expectedRevision: revision, keys: [], set: { enabled: false } }],
    ['more than 500 keys', { expectedRevision: revision, keys: Array.from({ length: 501 }, (_, i) => `k${String(i)}`), set: { enabled: false } }],
    ['an empty key', { expectedRevision: revision, keys: [''], set: { enabled: false } }],
    // L9: header injection through a mock header.
    ['a mock header name with a space', { expectedRevision: revision, keys: ['a'], set: { mock: { code: 200, body: '', headers: [{ name: 'X Bad', value: 'v' }] } } }],
    ['a mock header name with a colon', { expectedRevision: revision, keys: ['a'], set: { mock: { code: 200, body: '', headers: [{ name: 'X:Y', value: 'v' }] } } }],
    ['a mock header value with CRLF', { expectedRevision: revision, keys: ['a'], set: { mock: { code: 200, body: '', headers: [{ name: 'X-A', value: 'v\r\nSet-Cookie: x=1' }] } } }],
    ['a mock header value with NUL', { expectedRevision: revision, keys: ['a'], set: { mock: { code: 200, body: '', headers: [{ name: 'X-A', value: 'v\u0000' }] } } }],
  ])('rejects %s', async (_name, body) => {
    await expect(patch(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('header DTO (L9) on the API-wide transforms too', () => {
  const put = (headers: unknown) =>
    pipe.transform({ config: { transformRequestHeaders: { add: headers } } }, { type: 'body', metatype: UpdateApiDto });

  it('accepts RFC 7230 token names and ordinary values', async () => {
    await expect(put([{ name: "X-Request_Source.v1!#$%&'*+^`|~", value: 'open gateway; v=1' }])).resolves.toBeDefined();
  });

  it.each([['X Bad', 'v'], ['X:Y', 'v'], ['', 'v'], ['X-A', 'a\nb'], ['X-A', 'a\rb']])('rejects name %j / value %j', async (name, value) => {
    await expect(put([{ name, value }])).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PATCH /apis/:id cannot write endpoint governance', () => {
  it.each([
    ['endpoints', { endpoints: { a: { enabled: false } } }],
    ['restrictToSpec', { restrictToSpec: true }],
  ])('rejects config.%s', async (_name, config) => {
    await expect(pipe.transform({ config }, { type: 'body', metatype: UpdateApiDto })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
