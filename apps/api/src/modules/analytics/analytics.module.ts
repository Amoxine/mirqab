import { Module } from '@nestjs/common';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsRetentionScheduler } from './services/analytics-retention.scheduler';
import { PumpHealthService } from './services/pump-health.service';
import { AnalyticsController } from './controllers/analytics.controller';

/**
 * Analytics reads the Tyk Pump tables directly (D7), so this module needs neither
 * `TykIntegrationModule` nor its own `ScheduleModule.forRoot()` — `QuotasModule` owns that root.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRetentionScheduler, PumpHealthService],
  exports: [AnalyticsService],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AnalyticsModule {}
