import { Module } from '@nestjs/common';
import { GovernanceController } from './controllers/governance.controller';
import { GovernanceExportService } from './services/export.service';
import { GovernanceAdoptService } from './services/adopt.service';
import { GovernanceDriftService } from './services/drift.service';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { AuditModule } from '../audit/audit.module';
import { ApiManagementModule } from '../api-management/api-management.module';

@Module({
  imports: [TykIntegrationModule, AuditModule, ApiManagementModule],
  controllers: [GovernanceController],
  providers: [GovernanceExportService, GovernanceAdoptService, GovernanceDriftService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class GovernanceModule {}
