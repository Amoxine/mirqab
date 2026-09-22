import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisService } from './redis.service';

export interface RedisModuleOptions {
  /** Optional custom config key prefix (default: REDIS_URL) */
  configKey?: string;
}

@Module({})
// Static factories are how Nest builds a DynamicModule; the class carries no instance state.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RedisModule {
  static forRoot(_options?: RedisModuleOptions): DynamicModule {
    return {
      module: RedisModule,
      imports: [ConfigModule],
      providers: [RedisService],
      exports: [RedisService],
      global: true,
    };
  }

  static forFeature(): DynamicModule {
    return {
      module: RedisModule,
      providers: [RedisService],
      exports: [RedisService],
    };
  }
}
