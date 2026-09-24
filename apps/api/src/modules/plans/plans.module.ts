import { Module } from '@nestjs/common';
import { PlanController } from './controllers/plan.controller';
import { PlanService } from './services/plan.service';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { McpModule } from '../mcp/mcp.module';

@Module({
  // WP28: a plan's policy carries the per-primitive rate limits of the MCP tools it grants.
  imports: [TykIntegrationModule, McpModule],
  controllers: [PlanController],
  providers: [PlanService],
  exports: [PlanService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class PlansModule {}
