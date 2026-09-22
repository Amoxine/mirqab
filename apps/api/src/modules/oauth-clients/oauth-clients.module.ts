import { Module } from '@nestjs/common';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { OAuthClientController } from './controllers/oauth-client.controller';
import { HydraAdminService } from './services/hydra-admin.service';
import { OAuthClientService } from './services/oauth-client.service';

@Module({
  imports: [TykIntegrationModule],
  controllers: [OAuthClientController],
  providers: [HydraAdminService, OAuthClientService],
  exports: [OAuthClientService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class OAuthClientsModule {}
