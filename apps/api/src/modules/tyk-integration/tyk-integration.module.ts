import { Module } from '@nestjs/common';
import { TykClientService } from './services/tyk-client.service';
import { CircuitBreakerModule } from '../../common/circuit-breaker/circuit-breaker.module';

@Module({
  imports: [CircuitBreakerModule],
  providers: [TykClientService],
  exports: [TykClientService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class TykIntegrationModule {}
