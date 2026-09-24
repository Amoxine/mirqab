import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  ParseIntPipe,
  ParseEnumPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { KeyService } from '../services/key.service';
import { CreateKeyDto } from '../dto/create-key.dto';
import { UpdateKeyDto } from '../dto/update-key.dto';
import {
  KeyResponseDto,
  KeyListResponseDto,
  KeyDetailResponseDto,
} from '../dto/key-response.dto';
import { KeyUsageQueryDto, KeyUsageResponseDto } from '../dto/key-usage.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import { UserPayload } from '../../../common/types';
import { ApiKeyStatus } from '@prisma/client';

@ApiTags('API Keys')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('keys')
export class KeyController {
  constructor(private readonly keyService: KeyService) {}

  @Post()
  @Permissions('key:create')
  @Audit('key:created')
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Key created successfully',
    type: KeyResponseDto,
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid input' })
  async create(
    @Body() dto: CreateKeyDto,
    @CurrentUser() user: UserPayload,
    @CurrentTenant() tenantId: string,
  ): Promise<KeyResponseDto> {
    const result = await this.keyService.create(dto, tenantId, user.sub);
    return {
      id: result.id,
      name: result.name,
      status: result.status,
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
      keyValue: result.keyValue,
      apiDefId: result.apiDefId,
      planId: result.planId,
    };
  }

  @Get()
  @Permissions('key:read')
  @ApiOperation({ summary: 'List API keys with pagination' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Paginated list of API keys',
    type: KeyListResponseDto,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: ApiKeyStatus })
  @ApiQuery({ name: 'apiDefId', required: false, type: String, description: 'Only keys scoped to this API' })
  async findAll(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize = 20,
    @Query('status', new ParseEnumPipe(ApiKeyStatus, { optional: true })) status?: ApiKeyStatus,
    @Query('apiDefId', new ParseUUIDPipe({ optional: true })) apiDefId?: string,
    @CurrentTenant() tenantId?: string,
  ): Promise<KeyListResponseDto> {
    const result = await this.keyService.findAll(
      tenantId ?? '',
      page,
      pageSize,
      status,
      apiDefId,
    );
    return {
      data: result.data,
      meta: result.meta,
    };
  }

  @Get(':id')
  @Permissions('key:read')
  @ApiOperation({ summary: 'Get API key details, including live gateway limits' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'API key detail',
    type: KeyDetailResponseDto,
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<KeyDetailResponseDto> {
    return this.keyService.findOne(id, tenantId);
  }

  @Patch(':id')
  @Permissions('key:update')
  @Audit('key:updated')
  @ApiOperation({ summary: 'Update an API key (name, expiry, rate limit, quota)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'API key detail after the update',
    type: KeyDetailResponseDto,
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid input' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Key is not active' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKeyDto,
    @CurrentTenant() tenantId: string,
  ): Promise<KeyDetailResponseDto> {
    return this.keyService.update(id, dto, tenantId);
  }

  @Post(':id/revoke')
  @Permissions('key:revoke')
  @Audit('key:revoked')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Key revoked successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Key already revoked',
  })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ message: string }> {
    await this.keyService.revoke(id, tenantId);
    return { message: 'API key revoked successfully' };
  }

  @Get(':id/usage')
  @Permissions('key:read')
  @ApiOperation({ summary: 'Get API key usage statistics' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Usage statistics',
    type: KeyUsageResponseDto,
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  async getUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: KeyUsageQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<KeyUsageResponseDto> {
    const usage = await this.keyService.getUsage(id, tenantId, query.range);
    return { data: usage };
  }

  @Post(':id/rotate')
  @Permissions('key:update')
  @Audit('key:rotated')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint a new gateway credential for this key, keeping its settings' })
  @ApiResponse({ status: HttpStatus.OK, description: 'New raw key value — shown ONCE' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Key is not active' })
  async rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ id: string; keyValue: string }> {
    return this.keyService.rotate(id, tenantId);
  }

  @Post(':id/usage/reset')
  @Permissions('key:update')
  @Audit('key:usage_reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Zero this key's usage counter, locally and on the gateway" })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  async resetUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ apiKeyId: string; gatewayReset: boolean }> {
    return this.keyService.resetUsage(id, tenantId);
  }

  @Delete(':id')
  @Permissions('key:revoke')
  @Audit('key:deleted')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently delete a revoked or expired key row' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Key not found' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Key is still active — revoke it first' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenantId: string): Promise<void> {
    await this.keyService.remove(id, tenantId);
  }
}
