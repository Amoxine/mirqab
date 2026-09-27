import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditService } from './services/audit.service';
import { AuditController } from './controllers/audit.controller';
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';

@Module({
  // AnalyticsModule exports AnalyticsService: findRelatedTraffic (V1-LOG-01) reuses its tenant-scoped
  // Pump rollup instead of duplicating it. AnalyticsModule has no dependency back on this module.
  imports: [AnalyticsModule],
  controllers: [AuditController],
  // Global: @Audit() on any controller in any module is inert unless the interceptor is registered
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor }],
  exports: [AuditService],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuditModule {}
