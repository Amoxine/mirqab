import { Module } from '@nestjs/common';
import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookRelayController } from './controllers/webhook-relay.controller';
import { WebhookSubscriptionService } from './services/webhook-subscription.service';
import { WebhookRelayService } from './services/webhook-relay.service';
import { ApiManagementModule } from '../api-management/api-management.module';

@Module({
  // ApiManagementModule for ApiService — WebhookSubscriptionService reuses `syncNowWithNodes` rather
  // than talking to Tyk itself (see that service's own comment).
  imports: [ApiManagementModule],
  controllers: [WebhooksController, WebhookRelayController],
  providers: [WebhookSubscriptionService, WebhookRelayService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class WebhooksModule {}
