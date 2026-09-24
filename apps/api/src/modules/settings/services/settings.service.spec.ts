import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';
import { SettingsService } from './settings.service';

jest.mock('@open-gateway/database', () => ({
  prisma: { tenant: { findUniqueOrThrow: jest.fn() } },
}));

const db = prisma.tenant as unknown as { findUniqueOrThrow: jest.Mock };

function makeService(env: Record<string, string> = {}): SettingsService {
  return new SettingsService(new ConfigService(env));
}

describe('SettingsService.getSettings (WP14)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the tenant tykOrgId and the configured retention windows, scoped by tenant', async () => {
    db.findUniqueOrThrow.mockResolvedValue({ tykOrgId: 'og-tenant-1' });

    const settings = await makeService({
      ANALYTICS_RETENTION_DAYS: '14',
      ANALYTICS_AGGREGATE_RETENTION_DAYS: '90',
    }).getSettings('tenant-1');

    expect(settings).toEqual({
      tykOrgId: 'og-tenant-1',
      analyticsRetentionDays: 14,
      analyticsAggregateRetentionDays: 90,
    });
    expect(db.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      select: { tykOrgId: true },
    });
  });

  it('falls back to 30/365 days when the env vars are absent or invalid — same defaults as AnalyticsRetentionScheduler', async () => {
    db.findUniqueOrThrow.mockResolvedValue({ tykOrgId: 'og-tenant-2' });

    const settings = await makeService({ ANALYTICS_RETENTION_DAYS: 'nonsense' }).getSettings('tenant-2');

    expect(settings.analyticsRetentionDays).toBe(30);
    expect(settings.analyticsAggregateRetentionDays).toBe(365);
  });
});
