import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateKeyDto } from './update-key.dto';
import { KeyUsageQueryDto } from './key-usage.dto';

const invalidProps = async (body: Record<string, unknown>): Promise<string[]> =>
  (await validate(plainToInstance(UpdateKeyDto, body))).map((e) => e.property);

describe('UpdateKeyDto', () => {
  it('accepts an empty patch and every field on its own', async () => {
    for (const body of [
      {},
      { name: 'renamed' },
      { rateLimitPerSecond: 0 },
      { rateLimitPerSecond: 25 },
      { quotaLimit: 0 },
      { quotaLimit: 500, quotaPeriod: 'HOURLY' },
      { expiresAt: '2027-01-01T00:00:00.000Z' },
      { expiresAt: null },
    ]) {
      expect(await invalidProps(body)).toEqual([]);
    }
  });

  it('rejects an explicit null (or wrong type) on the non-nullable fields', async () => {
    expect(await invalidProps({ name: null })).toEqual(['name']);
    expect(await invalidProps({ rateLimitPerSecond: null })).toEqual(['rateLimitPerSecond']);
    expect(await invalidProps({ quotaLimit: null })).toEqual(['quotaLimit']);
    expect(await invalidProps({ quotaPeriod: null })).toEqual(['quotaPeriod']);
  });

  it.each([
    ['blank name', { name: '' }, 'name'],
    ['over-long name', { name: 'x'.repeat(101) }, 'name'],
    ['negative rate', { rateLimitPerSecond: -1 }, 'rateLimitPerSecond'],
    ['negative quota', { quotaLimit: -5 }, 'quotaLimit'],
    ['fractional quota', { quotaLimit: 1.5 }, 'quotaLimit'],
    ['quota beyond the Int column', { quotaLimit: 2_147_483_648 }, 'quotaLimit'],
    ['unknown period', { quotaPeriod: 'YEARLY' }, 'quotaPeriod'],
    ['non-date expiry', { expiresAt: 'tomorrow' }, 'expiresAt'],
  ])('rejects %s', async (_label, body, property) => {
    expect(await invalidProps(body)).toEqual([property]);
  });
});

describe('KeyUsageQueryDto', () => {
  it('accepts the four ranges and none, and rejects anything else', async () => {
    for (const range of ['1h', '24h', '7d', '30d', undefined]) {
      expect(await validate(plainToInstance(KeyUsageQueryDto, { range }))).toHaveLength(0);
    }
    expect(await validate(plainToInstance(KeyUsageQueryDto, { range: '1 year; DROP TABLE x' }))).toHaveLength(1);
  });
});
