import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  Delete,
  UseGuards,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
  ParseEnumPipe,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiService, ApiDetail, PaginatedResult } from '../services/api.service';
import type { NodeOutcome, TykDebugResult } from '../../tyk-integration/services/tyk-client.service';
import { DebugRequestDto } from '../dto/debug-request.dto';
import type { SyncState } from '../services/reconcile.service';
import { CreateApiDto } from '../dto/create-api.dto';
import { UpdateApiDto } from '../dto/update-api.dto';
import { CreateApiVersionDto } from '../dto/create-api-version.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import { PlanLimitGuard } from '../../plans/guards/plan-limit.guard';
import { AnalyticsRange } from '../../analytics/dto/analytics-query.dto';
import {
  TRAFFIC_DEFAULT_PAGE_SIZE,
  TRAFFIC_MAX_PAGE_SIZE,
  TrafficInspectorService,
  type TrafficPage,
} from '../../analytics/services/traffic-inspector.service';
import { ApiStatus, ApiSyncStatus } from '@prisma/client';

@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiManagementController {
  constructor(
    private readonly apiService: ApiService,
    private readonly trafficInspector: TrafficInspectorService,
  ) {}

  @Post()
  @Permissions('api:create')
  // WP18 (owner decision O7, hard block). Route-level, so it runs after the controller's
  // TenantIsolationGuard has put `tenantId` on the request. It is deliberately NOT on
  // `POST /apis/:id/versions`: a version is not a new API, see the guard's own note.
  @UseGuards(PlanLimitGuard)
  @ApiOperation({ summary: 'Create a new API definition' })
  @ApiResponse({ status: 201, description: 'API definition created successfully' })
  @ApiResponse({ status: 403, description: 'PLAN_LIMIT_EXCEEDED — the tenant plan’s API ceiling is reached' })
  @Audit('api:created', 'ApiDefinition')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateApiDto,
    @CurrentTenant() tenantId: string,
  ): Promise<ApiDetail> {
    return this.apiService.create(dto, tenantId);
  }

  @Post(':id/versions')
  @Permissions('api:create')
  @ApiOperation({
    summary: 'Create an OAS child version of an API',
    description:
      'A genuinely separate definition — its own proxyUrl/auth/config — selected via the ' +
      '`x-api-version` header against the default\'s listen path. OAS-format APIs only.',
  })
  @ApiResponse({ status: 201, description: 'Version created' })
  @ApiResponse({ status: 400, description: 'The API is CLASSIC-format, or is itself a version' })
  @Audit('api:created', 'ApiDefinition')
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateApiVersionDto,
    @CurrentTenant() tenantId: string,
  ): Promise<ApiDetail> {
    return this.apiService.createVersion(id, dto, tenantId);
  }

  @Get()
  @Permissions('api:read')
  @ApiOperation({ summary: 'List API definitions with pagination' })
  @ApiQuery({ name: 'status', required: false, enum: ApiStatus })
  @ApiQuery({ name: 'syncStatus', required: false, enum: ApiSyncStatus })
  @ApiQuery({ name: 'q', required: false, description: 'Case-insensitive match on name, slug or listen path' })
  async findAll(
    @CurrentTenant() tenantId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query('status', new ParseEnumPipe(ApiStatus, { optional: true })) status?: ApiStatus,
    @Query('syncStatus', new ParseEnumPipe(ApiSyncStatus, { optional: true })) syncStatus?: ApiSyncStatus,
    @Query('q') q?: string,
  ): Promise<PaginatedResult<ApiDetail>> {
    return this.apiService.findAll(tenantId, page, pageSize, status, syncStatus, q);
  }

  @Get(':id')
  @Permissions('api:read')
  @ApiOperation({ summary: 'Get a single API definition' })
  @ApiResponse({ status: 410, description: 'A retired API version (WP16); carries a Sunset header' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<ApiDetail> {
    // WP16: a retired version answers 410 (RetiredVersionException, thrown by the service) — a
    // deliberate, permanent removal, not a 404. AllExceptionsFilter adds the RFC 8594 Sunset header
    // from the exception's own `sunsetAt`.
    return this.apiService.findOne(id, tenantId);
  }

  @Patch(':id')
  @Permissions('api:update')
  @ApiOperation({ summary: 'Update an API definition' })
  @Audit('api:updated', 'ApiDefinition')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApiDto,
    @CurrentTenant() tenantId: string,
  ): Promise<ApiDetail> {
    return this.apiService.update(id, dto, tenantId);
  }

  @Delete(':id')
  @Permissions('api:delete')
  @ApiOperation({ summary: 'Delete an API definition (refused while active keys use it)' })
  @ApiResponse({ status: 409, description: 'Active keys still reference this API' })
  @Audit('api:deleted', 'ApiDefinition')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ message: string }> {
    return this.apiService.remove(id, tenantId);
  }

  @Post(':id/sync')
  @Permissions('api:sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-sync an API definition to every gateway node',
    description:
      '200 when every node accepted the definition, 207 when at least one did not. A partial ' +
      'fan-out is never reported as 200: the definition would be live on some nodes and stale on ' +
      'others, and the caller has to know that.',
  })
  @ApiResponse({ status: 207, description: 'At least one gateway node did not accept the definition' })
  @Audit('api:sync_succeeded', 'ApiDefinition')
  async sync(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiDetail & { nodes: NodeOutcome[] }> {
    const { detail, nodes } = await this.apiService.syncNowWithNodes(id, tenantId);

    // 207 rather than 502: the write DID land somewhere, so failing the whole call would be a lie
    // in the other direction. A node whose circuit is open lands here too — which is what keeps a
    // dead node from turning every sync into a 503 (per-node breaker, WP13a).
    if (nodes.some((n) => !n.ok)) res.status(HttpStatus.MULTI_STATUS);

    return { ...detail, nodes };
  }

  @Post(':id/debug')
  @Permissions('api:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a sample request against this API and return what the gateway saw',
    description:
      "The definition is rebuilt server-side from the stored row — a caller cannot supply one. The " +
      'optional `targetUrl` override carries the same SSRF deny list as the API\'s own proxyUrl, so a ' +
      'denied host is rejected with 400 before anything is sent. The gateway admin secret is ' +
      'redacted from the response and never reaches the browser.',
  })
  @ApiResponse({ status: 400, description: 'The target host is on the SSRF deny list' })
  async debug(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: DebugRequestDto,
  ): Promise<{ success: true; data: TykDebugResult }> {
    return { success: true, data: await this.apiService.debugRequest(id, tenantId, dto) };
  }

  @Get(':id/traffic')
  @Permissions('api:update')
  @ApiOperation({
    summary: 'Captured request/response detail for this API (detailed recording)',
    description:
      'Reuses `api:update` (owner decision, like `/debug`): no new permission, no backfill. Other ' +
      "people's real traffic, redacted twice — by the insert trigger, then on read by NAME PATTERN " +
      '(headers, query/form parameters and JSON fields that look like passwords, tokens, keys, ' +
      "cookies and the like, plus this API's own auth header), body cut at 16 KiB. `data.status` is " +
      '`NOT_ENABLED` only when recording is off AND nothing was ever captured, `FAILED` when the ' +
      'analytics store could not be read OR the redaction trigger is missing or disabled (then no ' +
      'row is shown at all), otherwise `OK` with a page (possibly empty).',
  })
  @ApiQuery({ name: 'range', required: false, enum: AnalyticsRange })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: `At most ${String(TRAFFIC_MAX_PAGE_SIZE)}` })
  async traffic(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Query('range', new DefaultValuePipe(AnalyticsRange.ONE_DAY), new ParseEnumPipe(AnalyticsRange))
    range: AnalyticsRange,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(TRAFFIC_DEFAULT_PAGE_SIZE), ParseIntPipe) pageSize: number,
  ): Promise<{ success: true; data: TrafficPage }> {
    return { success: true, data: await this.trafficInspector.list(tenantId, id, range, page, pageSize) };
  }

  @Post(':id/cache/invalidate')
  @Permissions('api:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Drop this API's cached responses on every gateway node",
    description:
      'Reuses `api:update` rather than introducing a cache permission: flushing a cache is a change ' +
      'to how the API behaves, and whoever may edit it may already cause the same effect by re-syncing.',
  })
  async invalidateCache(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { invalidated: boolean; keysDropped: number; nodes: NodeOutcome[] } }> {
    return { success: true, data: await this.apiService.invalidateCache(id, tenantId) };
  }

  @Get(':id/drift')
  @Permissions('api:read')
  @ApiOperation({
    summary: 'Per-node drift for one API definition',
    description:
      'Recomputed on demand, so it never reports a stale reconcile tick. `perNode` is keyed by the ' +
      'node URLs currently in TYK_ADMIN_URLS.',
  })
  async drift(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { inSync: boolean; differences: string[]; perNode: SyncState['nodes'] } }> {
    return { success: true, data: await this.apiService.drift(id, tenantId) };
  }
}
