import { Body, Controller, HttpCode, HttpStatus, Post, Query, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiImportService, type ImportPreview, type ImportResult } from '../services/api-import.service';
import { ImportQueryDto } from '../dto/import-query.dto';
import { ImportUrlDto, ImportUrlPreviewDto } from '../dto/spec-source.dto';
import { SpecSourceService, type SpecSourceView } from '../services/spec-source.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

/**
 * The raw document `specBodyMiddleware` read as text. An OBJECT means Nest's app-wide JSON parser got
 * there first (it runs before any route-scoped middleware, so a `Content-Type: application/json` body
 * is parsed — and capped at 100 kB — before this route sees it): refused with 415 instead of being
 * linted as an empty document. No body at all is linted as empty, like any unparseable document.
 */
export function rawDocument(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) {
    throw new UnsupportedMediaTypeException({
      message: 'Send the document as text/plain or application/yaml (not application/json); the format is detected from the content',
      error: 'OAS_IMPORT_WRONG_CONTENT_TYPE',
    });
  }
  return '';
}

@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiImportController {
  constructor(
    private readonly importService: ApiImportService,
    private readonly sources: SpecSourceService,
  ) {}

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
  @ApiResponse({ status: 415, description: 'Sent as application/json: send text/plain or application/yaml' })
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
    return {
      success: true,
      data: await this.importService.import(rawDocument(source), tenantId, query),
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
      data: await this.importService.preview(rawDocument(source), tenantId, query),
    };
  }
  /**
   * OAS-08: the same preview, for a document fetched server-side through the guarded fetcher (JSON
   * body, not the raw-document middleware). A fetch refusal is 422 `SPEC_FETCH_<CODE>`.
   */
  @Post('import/url/preview')
  @Permissions('api:create')
  @ApiOperation({ summary: 'Preview an OpenAPI import from a URL without creating anything' })
  @ApiResponse({ status: 422, description: 'SPEC_FETCH_<CODE>, or the same document errors as the import preview' })
  @HttpCode(HttpStatus.OK)
  async previewUrl(
    @Body() dto: ImportUrlPreviewDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ImportPreview }> {
    const { text } = await this.sources.fetchDocument(dto.url);
    return { success: true, data: await this.importService.preview(text, tenantId, { slug: dto.slug, serverIndex: dto.serverIndex }) };
  }

  /**
   * OAS-08: import from a URL. `watch: true` also creates the spec source, seeded with the fetch's
   * ETag / Last-Modified. The body is a POST, so the audit row stores none of it (no URL).
   */
  @Post('import/url')
  @Permissions('api:create')
  @ApiOperation({ summary: 'Import an OpenAPI 3.x document from a URL, optionally watching it for changes' })
  @ApiResponse({ status: 201, description: 'API created; `data.source` is the watched source when `watch: true`' })
  @ApiResponse({ status: 422, description: 'SPEC_FETCH_<CODE>, or the same document errors as the import' })
  @Audit('api:created', 'ApiDefinition')
  @HttpCode(HttpStatus.CREATED)
  async importUrl(
    @Body() dto: ImportUrlDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ImportResult & { source: SpecSourceView | null } }> {
    if (dto.watch) await this.sources.assertCapacity(tenantId);
    const fetched = await this.sources.fetchDocument(dto.url);
    const result = await this.importService.import(fetched.text, tenantId, { slug: dto.slug, serverIndex: dto.serverIndex });
    const source = dto.watch
      ? await this.sources.createWatched(tenantId, result.api.id, dto.url, dto.intervalMinutes ?? 60, fetched)
      : null;
    return { success: true, data: { ...result, source } };
  }
}
