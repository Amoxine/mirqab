import { Module } from '@nestjs/common';
import { RedisModule } from './redis/redis.module';
import { CircuitBreakerModule } from './circuit-breaker/circuit-breaker.module';

/**
 * Aggregates all common infrastructure modules.
 * Import this single module to get Redis, Circuit Breaker, and all
 * shared providers (guards, interceptors, decorators, types).
 */
@Module({
  imports: [
    RedisModule.forRoot(),
    CircuitBreakerModule,
  ],
  exports: [
    RedisModule,
    CircuitBreakerModule,
  ],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class CommonModule {}
