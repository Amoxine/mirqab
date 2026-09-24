import { Module } from '@nestjs/common';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { MetricsService } from './metrics.service';

/**
 * WP20's Prometheus registry. `RedisService` is global (`CommonModule`), `prisma` is imported
 * directly, so the only wiring needed is the gateway node list.
 */
@Module({
  imports: [TykIntegrationModule],
  providers: [MetricsService],
  exports: [MetricsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: metadata carrier
export class ObservabilityModule {}
