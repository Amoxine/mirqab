import { Module } from '@nestjs/common';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsRetentionScheduler } from './services/analytics-retention.scheduler';
import { PumpHealthService } from './services/pump-health.service';
import { TrafficAnalyticsService } from './services/traffic-analytics.service';
import { TrafficInspectorService } from './services/traffic-inspector.service';
import { AnalyticsController } from './controllers/analytics.controller';
import { TrafficSearchIndexerService } from './search/traffic-search.indexer.service';
import { TrafficSearchStoreService } from './search/traffic-search.store.service';

/**
 * Analytics reads the Tyk Pump tables directly (D7), so this module needs neither
 * `TykIntegrationModule` nor its own `ScheduleModule.forRoot()` — `QuotasModule` owns that root.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsRetentionScheduler,
    PumpHealthService,
    TrafficInspectorService,
    TrafficAnalyticsService,
    TrafficSearchStoreService,
    TrafficSearchIndexerService,
  ],
  // TrafficInspectorService: served by `GET /apis/:id/traffic` on the API controller (V1-LOG-02).
  exports: [AnalyticsService, TrafficInspectorService],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AnalyticsModule {}
