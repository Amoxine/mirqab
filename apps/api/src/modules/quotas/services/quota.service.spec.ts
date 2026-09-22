import 'reflect-metadata';
import { QuotaPeriod } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { QuotaService } from './quota.service';

jest.mock('@open-gateway/database', () => ({
  prisma: { quota: { create: jest.fn() } },
}));

const db = prisma as unknown as { quota: { create: jest.Mock } };

describe('QuotaService.create — calculateResetAt(MONTHLY)', () => {
  let service: QuotaService;

  beforeEach(() => {
    jest.resetAllMocks();
    db.quota.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'quota-1', ...data }),
    );
    service = new QuotaService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rolls day 31 to the 1st of the very next month, not skipping one (regression: setMonth-before-setDate overflow)', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 0, 31, 12, 0, 0)); // Jan 31, 2026

    const quota = await service.create('key-1', 1000, QuotaPeriod.MONTHLY);

    expect(quota.resetAt.getFullYear()).toBe(2026);
    expect(quota.resetAt.getMonth()).toBe(1); // February (0-indexed) — NOT March
    expect(quota.resetAt.getDate()).toBe(1);
  });

  it('rolls day 29 in a leap-year February to March 1', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2024, 1, 29, 9, 0, 0)); // Feb 29, 2024 (leap year)

    const quota = await service.create('key-1', 1000, QuotaPeriod.MONTHLY);

    expect(quota.resetAt.getFullYear()).toBe(2024);
    expect(quota.resetAt.getMonth()).toBe(2); // March
    expect(quota.resetAt.getDate()).toBe(1);
  });

  it('rolls a mid-month day normally', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 2, 15, 9, 0, 0)); // Mar 15, 2026

    const quota = await service.create('key-1', 1000, QuotaPeriod.MONTHLY);

    expect(quota.resetAt.getMonth()).toBe(3); // April
    expect(quota.resetAt.getDate()).toBe(1);
  });
});
