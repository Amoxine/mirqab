import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { KeysModule } from '../keys/keys.module';
import { QuotaService } from './services/quota.service';
import { QuotaResetScheduler } from './services/quota-reset.scheduler';

@Module({
  imports: [ScheduleModule.forRoot(), forwardRef(() => KeysModule)],
  providers: [QuotaService, QuotaResetScheduler],
  exports: [QuotaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class QuotasModule {}
