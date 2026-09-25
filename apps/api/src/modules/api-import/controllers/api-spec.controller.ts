import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { ApiSpecService, type ApiEndpointList, type ApiSpecDocument } from '../services/api-spec.service';

/**
 * Reads of the OpenAPI document an API was imported from (OAS-01). Both routes are `api:read`: they
 * expose what the API's own admins already see, and a spec of another tenant's API is a 404.
 */
@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiSpecController {
  constructor(private readonly specs: ApiSpecService) {}

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
    summary: 'The endpoints (method + path) of an API, from its stored OpenAPI document',
    description: 'The index computed at import, not a re-parse of the document.',
  })
  async endpoints(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ApiEndpointList }> {
    return { success: true, data: await this.specs.latestEndpoints(tenantId, id) };
  }
}
