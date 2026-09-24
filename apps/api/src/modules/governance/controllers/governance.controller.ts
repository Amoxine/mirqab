import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { GovernanceExportService, type ExportBundle } from '../services/export.service';
import { GovernanceAdoptService, type AdoptResult } from '../services/adopt.service';
import { GovernanceDriftService, type DriftReport } from '../services/drift.service';
import { AdoptFromGatewayDto } from '../dto/adopt-from-gateway.dto';

/**
 * `/governance/*` acts on APIs (plus plans/products for the export), so it reuses `api:read`/
 * `api:update` — no new permission family (DoD-OWNER 10, and the roadmap's own routing note).
 */
@ApiTags('Governance')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('governance')
export class GovernanceController {
  constructor(
    private readonly exportService: GovernanceExportService,
    private readonly adoptService: GovernanceAdoptService,
    private readonly driftService: GovernanceDriftService,
  ) {}

  @Get('drift')
  @Permissions('api:read')
  @ApiOperation({
    summary: 'Tenant-wide drift report',
    description:
      'Recomputed on demand from WP13a’s existing per-API drift check (ApiService.drift), one API ' +
      'at a time — the same machinery GET /apis/:id/drift uses, aggregated rather than reimplemented.',
  })
  async drift(@CurrentTenant() tenantId: string): Promise<{ success: true; data: DriftReport }> {
    return { success: true, data: await this.driftService.report(tenantId) };
  }

  @Post('export')
  @Permissions('api:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Export a deterministic bundle of this tenant’s APIs, plans and products',
    description:
      'Two calls over unchanged config are deep-equal after recursively sorting object keys ' +
      '(byte-identical output is not the contract). Contains no secrets: no keys, no OAuth2 ' +
      'clients, no gateway credentials — see GovernanceExportService for exactly why.',
  })
  async export(@CurrentTenant() tenantId: string): Promise<{ success: true; data: ExportBundle }> {
    return { success: true, data: await this.exportService.export(tenantId) };
  }

  @Post('apis/:id/adopt')
  @Permissions('api:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Operator escape hatch: overwrite config of record with one node’s current definition',
    description:
      'NOT a routine sync — the opposite direction of POST /apis/:id/sync. Requires api:update, ' +
      'always writes a mandatory AuditLog entry naming the node and the adopted fields, and the ' +
      'response labels itself as an override. See GovernanceAdoptService for what is and is not ' +
      'changed by this call.',
  })
  async adopt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdoptFromGatewayDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: AdoptResult }> {
    return { success: true, data: await this.adoptService.adopt(id, dto.nodeUrl, tenantId) };
  }
}
