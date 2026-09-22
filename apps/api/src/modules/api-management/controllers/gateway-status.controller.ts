import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GatewayStatus, GatewayStatusService } from '../services/gateway-status.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';

@ApiTags('Gateway')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('gateway')
export class GatewayStatusController {
  constructor(private readonly gatewayStatusService: GatewayStatusService) {}

  @Get('status')
  @Permissions('analytics:read')
  @ApiOperation({ summary: 'Gateway health plus API sync counts and failed syncs (HTTP 200 even when the gateway is down)' })
  async getStatus(@CurrentTenant() tenantId: string): Promise<GatewayStatus> {
    return this.gatewayStatusService.getStatus(tenantId);
  }
}
