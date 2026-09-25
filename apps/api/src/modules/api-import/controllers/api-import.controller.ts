import { Body, Controller, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiImportService, type ImportPreview, type ImportResult } from '../services/api-import.service';
import { ImportQueryDto } from '../dto/import-query.dto';
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
      'creates nothing; warnings are returned alongside the created API. The document is stored ' +
      '(`GET /apis/:id/spec`) and its endpoints indexed (`GET /apis/:id/endpoints`). Optional query ' +
      'overrides: `slug`, `serverIndex`.',
  })
  @ApiBody({ description: 'Raw OpenAPI 3.x document (JSON or YAML)', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'API created; `data.findings` carries any warnings' })
  @ApiResponse({ status: 413, description: 'Document larger than 5 MB' })
  @ApiResponse({ status: 422, description: 'Lint errors, or a document that yields no usable API' })
  // `created`, like a hand-written API: there is no `IMPORTED` in the AuditAction enum, and an unknown
  // label makes the audit write throw and get swallowed (audit-actions.tripwire.spec.ts guards this).
  @Audit('api:created', 'ApiDefinition')
  @HttpCode(HttpStatus.CREATED)
  async import(
    @Body() source: unknown,
    @Query() query: ImportQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ImportResult }> {
    // `specBodyMiddleware` installs a text parser for this route, so the body is a string. An empty
    // body arrives as '' and is rejected by the lint gate like any other unparseable document.
    return {
      success: true,
      data: await this.importService.import(typeof source === 'string' ? source : '', tenantId, query),
    };
  }

  /**
   * The same checks as `POST /apis/import`, and the same permission, but nothing is written: the
   * answer says what the import would create and what is wrong with the document. Not audited,
   * because it changes nothing.
   */
  @Post('import/preview')
  @Permissions('api:create')
  @ApiOperation({
    summary: 'Preview an OpenAPI import without creating anything',
    description:
      'Returns the derived API (name, slug, listen path, upstream), every server, any slug/listen-path ' +
      'conflict, the lint findings and the endpoint list. `valid: false` reports what to fix instead ' +
      'of failing; a document that cannot be processed at all still fails like the real import.',
  })
  @ApiBody({ description: 'Raw OpenAPI 3.x document (JSON or YAML)', schema: { type: 'string' } })
  @HttpCode(HttpStatus.OK)
  async preview(
    @Body() source: unknown,
    @Query() query: ImportQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ImportPreview }> {
    return {
      success: true,
      data: await this.importService.preview(typeof source === 'string' ? source : '', tenantId, query),
    };
  }
}
