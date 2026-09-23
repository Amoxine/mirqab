import { Module } from '@nestjs/common';
import { PlanController } from './controllers/plan.controller';
import { PlanService } from './services/plan.service';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';

@Module({
  imports: [TykIntegrationModule],
  controllers: [PlanController],
  providers: [PlanService],
  exports: [PlanService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class PlansModule {}
