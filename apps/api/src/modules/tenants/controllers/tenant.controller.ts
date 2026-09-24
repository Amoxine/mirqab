import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { UserPayload } from '../../../common/types';
import { TenantService } from '../services/tenant.service';
import { CreateTenantDto } from '../dto/create-tenant.dto';
import { UpdateTenantDto } from '../dto/update-tenant.dto';
import { PaginationDto } from '../dto/pagination.dto';
import { AssignUserDto } from '../dto/assign-user.dto';
import { UpdateMemberRoleDto } from '../dto/update-member-role.dto';
import { LookupUserDto } from '../dto/lookup-user.dto';
import {
  TenantResponseDto,
  TenantUserResponseDto,
  UserLookupResponseDto,
} from '../dto/tenant-response.dto';

interface PaginatedResponse<T> {
  success: true;
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

interface SingleResponse<T> {
  success: true;
  data: T;
}

/**
 * Tenant administration.
 *
 * Every route carries an explicit @Permissions() check. The reads had none at all — `GET /tenants`,
 * `GET /tenants/:id` and `GET /tenants/:id/users` listed every organisation on the installation and
 * its members' email addresses to any authenticated user — and the writes were gated by
 * `@Roles('SUPER_ADMIN', 'ADMIN')`, which matched nobody because roles are seeded lowercase.
 *
 * Permission names are the ones seeded in packages/database/prisma/seed.ts. The service scopes every
 * call to the caller's memberships (super_admin excepted), so holding tenant:read does not expose
 * other people's tenants.
 */
@ApiTags('Tenants')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Missing permission, no tenant, or not a member' })
@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  // ─── CREATE ───────────────────────────────────────────────────────────────

  @Post()
  @Permissions('tenant:create')
  @Audit('tenant:created', 'Tenant')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new tenant' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Tenant created successfully',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Slug already exists' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
  async create(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantResponseDto>> {
    const data = await this.tenantService.create(dto, user);
    return { success: true, data };
  }

  // ─── LIST ALL ─────────────────────────────────────────────────────────────

  @Get()
  @Permissions('tenant:read')
  @ApiOperation({ summary: "List the caller's tenants with pagination (all tenants for super_admin)" })
  @ApiResponse({ status: HttpStatus.OK, description: 'Paginated tenant list' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 20 })
  async findAll(
    @Query() pagination: PaginationDto,
    @CurrentUser() user: UserPayload,
  ): Promise<PaginatedResponse<TenantResponseDto>> {
    const result = await this.tenantService.findAll(pagination, user);
    return {
      success: true,
      data: result.data,
      meta: result.meta,
    };
  }

  // ─── GET SINGLE ───────────────────────────────────────────────────────────

  @Get(':id')
  @Permissions('tenant:read')
  @ApiOperation({ summary: 'Get a single tenant by ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Tenant details' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Tenant not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantResponseDto>> {
    const data = await this.tenantService.findOne(id, user);
    return { success: true, data };
  }

  // ─── UPDATE ───────────────────────────────────────────────────────────────

  @Patch(':id')
  @Permissions('tenant:update')
  @Audit('tenant:updated', 'Tenant')
  @ApiOperation({ summary: 'Update a tenant' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Tenant updated successfully' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Tenant not found' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Slug already exists' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantResponseDto>> {
    const data = await this.tenantService.update(id, dto, user);
    return { success: true, data };
  }

  // ─── SOFT DELETE (ARCHIVE) ────────────────────────────────────────────────

  @Delete(':id')
  @Permissions('tenant:delete')
  @Audit('tenant:deleted', 'Tenant')
  @ApiOperation({ summary: 'Archive (soft delete) a tenant' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Tenant archived successfully' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Tenant not found' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Tenant is already archived',
  })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantResponseDto>> {
    const data = await this.tenantService.archive(id, user);
    return { success: true, data };
  }

  // ─── LIST USERS IN TENANT ─────────────────────────────────────────────────

  @Get(':id/users')
  @Permissions('user:read')
  @ApiOperation({ summary: 'List all users assigned to a tenant' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Tenant users list' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Tenant not found' })
  async findUsers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantUserResponseDto[]>> {
    const data = await this.tenantService.findUsers(id, user);
    return { success: true, data };
  }

  // ─── ASSIGN USER TO TENANT ────────────────────────────────────────────────

  @Post(':id/users')
  @Permissions('user:create')
  @Audit('tenant:assigned', 'UserTenant')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Assign a user to a tenant' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'User assigned to tenant successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Tenant or user not found' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'User already assigned to this tenant',
  })
  async assignUser(
    @Param('id', ParseUUIDPipe) tenantId: string,
    @Body() body: AssignUserDto,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantUserResponseDto>> {
    const data = await this.tenantService.assignUser(
      tenantId,
      body.userId,
      body.role,
      user,
    );
    return { success: true, data };
  }

  // ─── LOOKUP USER BY EMAIL (for invites) ───────────────────────────────────

  @Get(':id/users/lookup')
  @Permissions('user:read')
  @ApiOperation({ summary: 'Find an existing user by email, to invite them into this tenant' })
  @ApiQuery({ name: 'email', required: true, type: String })
  @ApiResponse({ status: HttpStatus.OK, description: 'The match, or null if none' })
  async lookupUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LookupUserDto,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<UserLookupResponseDto | null>> {
    const data = await this.tenantService.lookupUserByEmail(id, query.email, user);
    return { success: true, data };
  }

  // ─── CHANGE A MEMBER'S ROLE ────────────────────────────────────────────────

  @Patch(':id/users/:userId')
  @Permissions('user:update')
  @Audit('tenant:role_changed', 'UserTenant')
  @ApiOperation({ summary: "Change a member's role" })
  @ApiResponse({ status: HttpStatus.OK, description: 'Role updated successfully' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User is not a member of this tenant' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Would leave the tenant with no admin",
  })
  async updateMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @CurrentUser() user: UserPayload,
  ): Promise<SingleResponse<TenantUserResponseDto>> {
    const data = await this.tenantService.updateMemberRole(id, userId, dto.role, user);
    return { success: true, data };
  }

  // ─── REMOVE A MEMBER ───────────────────────────────────────────────────────

  @Delete(':id/users/:userId')
  @Permissions('user:delete')
  @Audit('tenant:unassigned', 'UserTenant')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from the tenant' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Member removed successfully' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User is not a member of this tenant' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Would leave the tenant with no admin",
  })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: UserPayload,
  ): Promise<void> {
    await this.tenantService.removeMember(id, userId, user);
  }
}
