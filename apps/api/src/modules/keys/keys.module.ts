import { Module, forwardRef } from '@nestjs/common';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { QuotasModule } from '../quotas/quotas.module';
import { McpModule } from '../mcp/mcp.module';
import { KeyService } from './services/key.service';
import { KeyController } from './controllers/key.controller';

@Module({
  imports: [
    TykIntegrationModule,
    forwardRef(() => QuotasModule),
    // WP28: a key scoped to an MCP server needs that server's tool grant for its plan. Plain
    // import, not forwardRef — McpModule imports nothing from here.
    McpModule,
  ],
  controllers: [KeyController],
  providers: [KeyService],
  exports: [KeyService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class KeysModule {}
