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
import type { NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import type { SyncState } from '../services/reconcile.service';
import { CreateApiDto } from '../dto/create-api.dto';
import { UpdateApiDto } from '../dto/update-api.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import { ApiStatus, ApiSyncStatus } from '@prisma/client';

@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class ApiManagementController {
  constructor(private readonly apiService: ApiService) {}

  @Post()
  @Permissions('api:create')
  @ApiOperation({ summary: 'Create a new API definition' })
  @ApiResponse({ status: 201, description: 'API definition created successfully' })
  @Audit('api:created', 'ApiDefinition')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateApiDto,
    @CurrentTenant() tenantId: string,
  ): Promise<ApiDetail> {
    return this.apiService.create(dto, tenantId);
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
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<ApiDetail> {
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
