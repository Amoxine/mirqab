import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateApiDto } from './update-api.dto';
import { CreateApiDto } from './create-api.dto';

// Same options as main.ts — forbidNonWhitelisted is what makes an undecorated field a 400.
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const cors = {
  enable: true,
  allowedOrigins: ['http://localhost:33000'],
  allowedMethods: ['GET'],
  allowedHeaders: ['Authorization'],
  exposedHeaders: [],
  allowCredentials: true,
  maxAge: 24,
};

const patch = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateApiDto });

describe('config validation (PATCH /apis/:id)', () => {
  it('accepts a full config and keeps nested values', async () => {
    const dto = (await patch({ config: { rateLimit: { rate: 100, per: 60 }, cors, doNotTrack: false } })) as UpdateApiDto;
    expect(dto.config?.rateLimit).toEqual({ rate: 100, per: 60 });
    expect(dto.config?.cors?.allowedOrigins).toEqual(['http://localhost:33000']);
    expect(dto.authType).toBeUndefined();
  });

  it('accepts rate 0 and null sections', async () => {
    await expect(patch({ config: { rateLimit: { rate: 0, per: 1 }, cors: null } })).resolves.toBeDefined();
  });

  it.each([
    ['negative rate', { rateLimit: { rate: -1, per: 60 } }],
    ['per below 1', { rateLimit: { rate: 10, per: 0 } }],
    ['non-integer rate', { rateLimit: { rate: 1.5, per: 60 } }],
    ['unknown top-level field', { rateLimt: { rate: 1, per: 1 } }],
    ['unknown rateLimit field', { rateLimit: { rate: 1, per: 1, burst: 5 } }],
    ['unknown cors field', { cors: { ...cors, debug: true } }],
    ['cors origins not strings', { cors: { ...cors, allowedOrigins: [1] } }],
    ['cors missing enable', { cors: { ...cors, enable: undefined } }],
    ['negative maxAge', { cors: { ...cors, maxAge: -5 } }],
    ['doNotTrack not boolean', { doNotTrack: 'yes' }],
  ])('rejects %s', async (_name, config) => {
    await expect(patch({ config })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CreateApiDto.listenPath', () => {
  const create = (listenPath: string) =>
    pipe.transform(
      { name: 'Orders', slug: 'orders', proxyUrl: 'http://orders:4000', listenPath },
      { type: 'body', metatype: CreateApiDto },
    );

  it('accepts a path starting with /', async () => {
    await expect(create('/orders/')).resolves.toBeDefined();
  });

  it('rejects a path that does not start with /', async () => {
    await expect(create('orders/')).rejects.toBeInstanceOf(BadRequestException);
  });
});
