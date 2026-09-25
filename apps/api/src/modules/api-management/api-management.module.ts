import { Module } from '@nestjs/common';
import { ApiManagementController } from './controllers/api.controller';
import { GatewayStatusController } from './controllers/gateway-status.controller';
import { ApiService } from './services/api.service';
import { GatewayStatusService } from './services/gateway-status.service';
import { ReconcileService } from './services/reconcile.service';
import { HealthCheckService } from './services/health-check.service';
import { EndpointGovernanceService } from './services/endpoint-governance.service';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { OAuthClientsModule } from '../oauth-clients/oauth-clients.module';

@Module({
  imports: [TykIntegrationModule, OAuthClientsModule],
  controllers: [ApiManagementController, GatewayStatusController],
  // No `ScheduleModule.forRoot()` here — QuotasModule owns the single root (see
  // analytics.module.ts's comment); `@Interval` on ReconcileService is discovered from it.
  providers: [ApiService, GatewayStatusService, ReconcileService, HealthCheckService, EndpointGovernanceService],
  exports: [ApiService, ReconcileService, HealthCheckService, EndpointGovernanceService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class ApiManagementModule {}
