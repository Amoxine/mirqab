import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiImportService, type ImportResult } from '../services/api-import.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiImportController {
  constructor(private readonly importService: ApiImportService) {}

  /**
   * Gated on `api:create`, not a new permission: importing a spec creates an `ApiDefinition`, so it
   * is the same capability reached a different way. A separate `api:import` would be a permission a
   * tenant admin could grant without meaning to allow API creation, which it cannot prevent.
   */
  @Post('import')
  @Permissions('api:create')
  @ApiOperation({
    summary: 'Import an OpenAPI 3.x document as a new API definition',
    description:
      'Body is the raw OAS document, JSON or YAML, up to 5 MB (larger: 413). It is linted against ' +
      'the repo Spectral ruleset: any error-severity finding rejects the import with 422 and ' +
      'creates nothing; warnings are returned alongside the created API.',
  })
  @ApiBody({ description: 'Raw OpenAPI 3.x document (JSON or YAML)', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'API created; `data.findings` carries any warnings' })
  @ApiResponse({ status: 413, description: 'Document larger than 5 MB' })
  @ApiResponse({ status: 422, description: 'Lint errors, or a document that yields no usable API' })
  @Audit('api:imported', 'ApiDefinition')
  @HttpCode(HttpStatus.CREATED)
  async import(
    @Body() source: unknown,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ImportResult }> {
    // `specBodyMiddleware` installs a text parser for this route, so the body is a string. An empty
    // body arrives as '' and is rejected by the lint gate like any other unparseable document.
    return {
      success: true,
      data: await this.importService.import(typeof source === 'string' ? source : '', tenantId),
    };
  }
}
