import { Module } from '@nestjs/common';
import { McpController } from './controllers/mcp.controller';
import { McpService } from './services/mcp.service';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';

@Module({
  imports: [TykIntegrationModule],
  controllers: [McpController],
  providers: [McpService],
  // PlansModule and KeysModule import this for the two policy fragments only (`planAccessRights`,
  // `keyAccessRight`). McpService imports neither of them back — it validates a plan id with a
  // direct query — so there is no cycle and no forwardRef anywhere.
  exports: [McpService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class McpModule {}
