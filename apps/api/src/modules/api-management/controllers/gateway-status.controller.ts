import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GatewayStatus, GatewayStatusService, type GatewaySummary } from '../services/gateway-status.service';
import type { NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

@ApiTags('Gateway')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('gateway')
export class GatewayStatusController {
  constructor(private readonly gatewayStatusService: GatewayStatusService) {}

  // WP14: re-gated from analytics:read — this is settings surface (U17), not an analytics read.
  @Get('status')
  @Permissions('settings:read')
  @ApiOperation({ summary: 'Gateway health plus API sync counts and failed syncs (HTTP 200 even when the gateway is down)' })
  async getStatus(@CurrentTenant() tenantId: string): Promise<GatewayStatus> {
    return this.gatewayStatusService.getStatus(tenantId);
  }

  @Get('nodes/health')
  @Permissions('settings:read')
  @ApiOperation({ summary: 'Read-only /hello probe for every node in TYK_ADMIN_URLS (never a node CRUD route — see plan §2.5)' })
  async getNodeHealth(): Promise<{ nodeUrl: string; health: GatewaySummary }[]> {
    return this.gatewayStatusService.getNodeHealth();
  }

  // No :id / body: this fans out to every configured node, not a node the caller picks — there is
  // no node CRUD to pick one FROM (plan §2.5 / A1). Rate limiting: the existing global throttler
  // already bounds this (ThrottlerModule.forRoot in app.module.ts) — a blocking ~0.91s-per-node
  // reload does not need a second, bespoke limiter on top.
  @Post('reload')
  @Permissions('settings:update')
  @Audit('gateway:updated', 'Gateway')
  @ApiOperation({ summary: 'Reload every configured gateway node, blocking, and report per-node latency' })
  async reload(): Promise<NodeOutcome<{ latencyMs: number }>[]> {
    return this.gatewayStatusService.reloadAll();
  }
}
