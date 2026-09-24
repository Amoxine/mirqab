import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';

/** `GET /settings` response: the tenant's Tyk org and the two config-only analytics windows. */
export interface TenantSettings {
  tykOrgId: string;
  analyticsRetentionDays: number;
  analyticsAggregateRetentionDays: number;
}

// Same defaults as AnalyticsRetentionScheduler — this is a read-only VIEW of that config, not a
// second source of truth for it, so the fallback values must match exactly.
const DEFAULT_RAW_RETENTION_DAYS = 30;
const DEFAULT_AGGREGATE_RETENTION_DAYS = 365;

/**
 * WP14: everything here is config, not a resource — `tykOrgId` is derived once at tenant creation
 * (`tykOrgIdFor`, schema.prisma) and the retention windows are env vars. Nothing in this module
 * writes any of it; the one write this WP ships (`POST /gateway/reload`) lives in
 * GatewayStatusController, which already owned the `/gateway` prefix.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly configService: ConfigService) {}

  async getSettings(tenantId: string): Promise<TenantSettings> {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { tykOrgId: true },
    });

    return {
      tykOrgId: tenant.tykOrgId,
      analyticsRetentionDays: this.positiveDays('ANALYTICS_RETENTION_DAYS', DEFAULT_RAW_RETENTION_DAYS),
      analyticsAggregateRetentionDays: this.positiveDays(
        'ANALYTICS_AGGREGATE_RETENTION_DAYS',
        DEFAULT_AGGREGATE_RETENTION_DAYS,
      ),
    };
  }

  // Same pattern as AnalyticsRetentionScheduler.positiveDays: single-arg `get<T>(key)`, not the
  // two-arg `get<T>(key, default)` overload, so no NoInferType complication here.
  private positiveDays(key: string, fallback: number): number {
    const configured = Number(this.configService.get<string>(key));
    return Number.isInteger(configured) && configured > 0 ? configured : fallback;
  }
}
