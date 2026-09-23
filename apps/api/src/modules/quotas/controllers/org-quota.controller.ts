import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { QuotaPeriod } from '@prisma/client';
import { OrgQuotaService, type OrgQuotaState } from '../services/org-quota.service';
import { MeteringService } from '../services/metering.service';
import type { NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

export class SetOrgQuotaDto {
  @ApiProperty({ example: 1000000, description: '**-1 is unlimited** (Tyk convention); 0 refuses everything.' })
  @IsInt()
  @Min(-1)
  quotaMax!: number;

  @ApiPropertyOptional({ enum: QuotaPeriod, default: QuotaPeriod.MONTHLY })
  @IsOptional()
  @IsEnum(QuotaPeriod)
  period?: QuotaPeriod;

  @ApiPropertyOptional({ default: false, description: 'Cut the tenant off entirely.' })
  @IsOptional()
  @IsBoolean()
  isInactive?: boolean;
}

/**
 * Org-level quota and the admin reset actions (WP18).
 *
 * Gated on the existing `settings:*` pair rather than a new permission family: this is one tenant's
 * own ceiling and its own counters, which is tenant configuration, and §2.5/A1 keeps the permission
 * catalogue free of anything platform-scoped. Nothing here can read or change another tenant —
 * every route resolves the org from `@CurrentTenant()`, never from the request body.
 */
@ApiTags('Quotas')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('quotas')
export class OrgQuotaController {
  constructor(
    private readonly orgQuota: OrgQuotaService,
    private readonly metering: MeteringService,
  ) {}

  @Get('org')
  @Permissions('settings:read')
  @ApiOperation({ summary: "Read this tenant's org-level quota state" })
  async getOrg(@CurrentTenant() tenantId: string): Promise<{ success: true; data: OrgQuotaState }> {
    return { success: true, data: await this.orgQuota.get(tenantId) };
  }

  @Put('org')
  @Permissions('settings:update')
  @ApiOperation({ summary: "Set this tenant's org-level quota ceiling" })
  @Audit('quota:org_updated', 'Tenant')
  async setOrg(
    @Body() dto: SetOrgQuotaDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { tykOrgId: string; nodes: NodeOutcome[] } }> {
    return { success: true, data: await this.orgQuota.set(tenantId, dto) };
  }

  @Post('org/reset')
  @Permissions('settings:update')
  @ApiOperation({
    summary: "Zero this tenant's org usage counter",
    description: 'Drops and re-applies the org session — the ceiling is kept, the counter goes back to full.',
  })
  @Audit('quota:org_reset', 'Tenant')
  @HttpCode(HttpStatus.OK)
  async resetOrg(
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { tykOrgId: string; restored: boolean } }> {
    return { success: true, data: await this.orgQuota.reset(tenantId) };
  }

  @Post('keys/:id/reset')
  @Permissions('settings:update')
  @ApiOperation({
    summary: "Zero one key's usage counter",
    description: 'Resets both the reported counter and the one the gateway enforces.',
  })
  @Audit('quota:key_reset', 'ApiKey')
  @HttpCode(HttpStatus.OK)
  async resetKey(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { apiKeyId: string; gatewayReset: boolean } }> {
    return { success: true, data: await this.orgQuota.resetKey(id, tenantId) };
  }

  @Post('meter')
  @Permissions('settings:update')
  @ApiOperation({
    summary: 'Run the metering pass now',
    description: 'The same pass the hourly job runs. Idempotent — it recomputes totals, never accumulates.',
  })
  @HttpCode(HttpStatus.OK)
  async meter(): Promise<{ success: true; data: { quotasUpdated: number } }> {
    return { success: true, data: { quotasUpdated: await this.metering.meterAll() } };
  }
}
