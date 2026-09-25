import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import { ApiSpecService, type ApiSpecDocument } from '../services/api-spec.service';
import {
  EndpointGovernanceService,
  type EndpointGovernanceView,
} from '../../api-management/services/endpoint-governance.service';
import { UpdateEndpointsDto } from '../../api-management/dto/update-endpoints.dto';

/**
 * The OpenAPI document an API was imported from (OAS-01) and the governance of its endpoints (OAS-03).
 * Reads are `api:read`: they expose what the API's own admins already see. The governance write is
 * `api:update`. Another tenant's API is a 404 everywhere.
 */
@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiSpecController {
  constructor(
    private readonly specs: ApiSpecService,
    private readonly governance: EndpointGovernanceService,
  ) {}

  @Get(':id/spec')
  @Permissions('api:read')
  @ApiOperation({
    summary: 'The stored OpenAPI document of an API (newest version, source text as submitted)',
    description: '404 when the API was not created from a specification or belongs to another tenant.',
  })
  async spec(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ApiSpecDocument }> {
    return { success: true, data: await this.specs.latest(tenantId, id) };
  }

  @Get(':id/endpoints')
  @Permissions('api:read')
  @ApiOperation({
    summary: 'The endpoints (method + path) of an API with their governance, from its stored OpenAPI document',
    description:
      'The index computed at import joined with `config.endpoints`; `orphans` are governed keys no longer in the ' +
      'index; `revision` is what PATCH must present; `capabilities` says which controls the gateway enforces.',
  })
  async endpoints(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: EndpointGovernanceView }> {
    return { success: true, data: await this.governance.list(tenantId, id) };
  }

  @Patch(':id/endpoints')
  @Permissions('api:update')
  @Audit('api:updated', 'ApiDefinition')
  @ApiOperation({
    summary: 'Govern endpoints (block, public, rate limit, cache, timeout, size limit, mock, validation) or allow-list mode',
    description:
      'Compare-and-set on `expectedRevision` (stale -> 409 ENDPOINT_REVISION_STALE). The API then re-syncs in the ' +
      'background; `syncStatus` is PENDING until every gateway node reports the governed operations as sent.',
  })
  async updateEndpoints(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateEndpointsDto,
  ): Promise<{ success: true; data: EndpointGovernanceView }> {
    return { success: true, data: await this.governance.update(tenantId, id, dto) };
  }
}
