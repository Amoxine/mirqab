import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { rawDocument } from './api-import.controller';
import { SpecPreviewQueryDto, SpecUpdateQueryDto } from '../dto/spec-update-query.dto';
import { SpecUpdateService, type SpecUpdateResult } from '../services/spec-update.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

const BODY = { description: 'Raw OpenAPI 3.x document (JSON or YAML text; send text/plain or application/yaml)', schema: { type: 'string' } };

/**
 * Re-upload of an API's OpenAPI document (OAS-04). Both routes are `api:update`: a new spec version
 * changes what the gateway serves for this API at its next sync, and the preview shows exactly that.
 */
@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiSpecUpdateController {
  constructor(private readonly specUpdate: SpecUpdateService) {}

  /** Same checks and answer as the apply, but nothing is written; not audited, like the import preview. */
  @Post(':id/spec/preview')
  @Permissions('api:update')
  @ApiOperation({
    summary: 'Diff a changed OpenAPI document against the stored one, without applying it',
    description:
      'Same body, gates and response as `POST /apis/:id/spec`, with `dryRun: true, applied: false`. Lint errors are ' +
      'reported in `findings`. `expectedVersion` = the latest versionNo (0 when the API has no stored spec).',
  })
  @ApiBody(BODY)
  @ApiResponse({ status: 409, description: 'Stale expectedVersion' })
  @HttpCode(HttpStatus.OK)
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() source: unknown,
    @Query() query: SpecPreviewQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: SpecUpdateResult }> {
    return {
      success: true,
      data: await this.specUpdate.update(rawDocument(source), tenantId, id, {
        dryRun: true,
        expectedVersion: query.expectedVersion,
        acknowledgeRemoved: false,
      }),
    };
  }

  @Post(':id/spec')
  @Permissions('api:update')
  @ApiOperation({
    summary: 'Apply a changed OpenAPI document to an existing API as its next spec version',
    description:
      'Body is the raw OAS 3.x document (≤ 5 MB), checked by the same gates as the import. `expectedVersion` = the ' +
      'latest versionNo, or 0 to attach a first spec to an API that has none (stale: 409 SPEC_VERSION_STALE). When ' +
      'governed endpoints disappear, `acknowledgeRemoved=true` is required (else 409 SPEC_REMOVES_GOVERNED_ENDPOINTS). ' +
      'The same bytes as the latest version answer `unchanged: true` and write nothing.',
  })
  @ApiBody(BODY)
  @ApiResponse({ status: 404, description: 'No such API in this tenant' })
  @ApiResponse({ status: 409, description: 'Stale expectedVersion, unacknowledged removal, or a concurrent config change' })
  @ApiResponse({ status: 415, description: 'Sent as application/json' })
  @ApiResponse({ status: 422, description: 'Lint errors, unsafe or unsupported document' })
  @Audit('api:updated', 'ApiDefinition')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() source: unknown,
    @Query() query: SpecUpdateQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: SpecUpdateResult }> {
    return {
      success: true,
      data: await this.specUpdate.update(rawDocument(source), tenantId, id, {
        dryRun: false,
        expectedVersion: query.expectedVersion,
        acknowledgeRemoved: query.acknowledgeRemoved ?? false,
      }),
    };
  }
}
