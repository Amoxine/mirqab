import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  AnalyticsListQueryDto,
  AnalyticsRange,
  AnalyticsTopApisQueryDto,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_TOP_APIS_LIMIT,
} from './analytics-query.dto';

// Same options as main.ts, so this exercises the real query-string path (values arrive as strings).
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const query = (value: unknown) => pipe.transform(value, { type: 'query', metatype: AnalyticsTopApisQueryDto });

describe('AnalyticsTopApisQueryDto', () => {
  it('coerces the string limit a query string actually delivers', async () => {
    const dto = (await query({ range: '24h', limit: '5' })) as AnalyticsTopApisQueryDto;
    expect(dto.limit).toBe(5);
    expect(dto.range).toBe(AnalyticsRange.ONE_DAY);
  });

  it('defaults limit to 10 and range to 24h', async () => {
    const dto = (await query({})) as AnalyticsTopApisQueryDto;
    expect(dto.limit).toBe(10);
    expect(dto.range).toBe(AnalyticsRange.ONE_DAY);
  });

  it('accepts the documented boundaries', async () => {
    expect(((await query({ limit: '1' })) as AnalyticsTopApisQueryDto).limit).toBe(1);
    expect(((await query({ limit: String(MAX_TOP_APIS_LIMIT) })) as AnalyticsTopApisQueryDto).limit).toBe(
      MAX_TOP_APIS_LIMIT,
    );
  });

  it.each([['0'], ['51'], ['2.5'], ['abc']])('rejects limit=%s', async (limit) => {
    await expect(query({ limit })).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown range', async () => {
    await expect(query({ range: '3h' })).rejects.toThrow(BadRequestException);
  });
});

describe('AnalyticsListQueryDto (/analytics/apis, /analytics/keys)', () => {
  const list = (value: unknown) => pipe.transform(value, { type: 'query', metatype: AnalyticsListQueryDto });

  it('defaults to 50 rows and 24h, so a web call without params stays bounded', async () => {
    const dto = (await list({})) as AnalyticsListQueryDto;
    expect(dto.limit).toBe(DEFAULT_LIST_LIMIT);
    expect(DEFAULT_LIST_LIMIT).toBe(50);
    expect(dto.range).toBe(AnalyticsRange.ONE_DAY);
  });

  it('coerces the string limit and accepts 1..100', async () => {
    expect(((await list({ limit: '1' })) as AnalyticsListQueryDto).limit).toBe(1);
    expect(((await list({ limit: String(MAX_LIST_LIMIT) })) as AnalyticsListQueryDto).limit).toBe(100);
  });

  it.each([['0'], ['101'], ['2.5'], ['abc']])('rejects limit=%s', async (limit) => {
    await expect(list({ limit })).rejects.toThrow(BadRequestException);
  });

  it('still rejects unknown params (whitelist stays on)', async () => {
    await expect(list({ range: '1h', page: '2' })).rejects.toThrow(BadRequestException);
  });
});
