import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { KeysModule } from '../keys/keys.module';
import { AuditModule } from '../audit/audit.module';
import { QuotaService } from './services/quota.service';
import { QuotaResetScheduler } from './services/quota-reset.scheduler';
import { MeteringService } from './services/metering.service';
import { OrgQuotaService } from './services/org-quota.service';
import { OrgQuotaController } from './controllers/org-quota.controller';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';

@Module({
  imports: [ScheduleModule.forRoot(), forwardRef(() => KeysModule), TykIntegrationModule, AuditModule],
  controllers: [OrgQuotaController],
  providers: [QuotaService, QuotaResetScheduler, MeteringService, OrgQuotaService],
  exports: [QuotaService, MeteringService, OrgQuotaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class QuotasModule {}
