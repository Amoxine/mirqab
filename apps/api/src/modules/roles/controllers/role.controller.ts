import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RoleService, type PermissionCatalogEntry, type RoleDetail } from '../services/role.service';
import { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

/**
 * Custom roles per tenant (U18) — wires the 4 previously-unused `role:*` permissions. See
 * RoleService's doc comment for why `super_admin` is rejected everywhere here rather than merely
 * "not offered" — the reserved name IS the platform-scoped capability, not a permission grant.
 */
@ApiTags('Roles')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  // Declared before `:id` so `/roles/permissions` is not swallowed as a (non-UUID) `:id`.
  @Get('permissions')
  @Permissions('role:read')
  @ApiOperation({ summary: 'The full permission catalogue, for the role matrix' })
  async permissionCatalog(): Promise<{ success: true; data: PermissionCatalogEntry[] }> {
    return { success: true, data: await this.roleService.permissionCatalog() };
  }

  @Get()
  @Permissions('role:read')
  @ApiOperation({ summary: 'List custom roles for this tenant' })
  async findAll(@CurrentTenant() tenantId: string): Promise<{ success: true; data: RoleDetail[] }> {
    return { success: true, data: await this.roleService.findAll(tenantId) };
  }

  @Get(':id')
  @Permissions('role:read')
  @ApiOperation({ summary: 'Get a role and its permissions' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: RoleDetail }> {
    return { success: true, data: await this.roleService.findOne(id, tenantId) };
  }

  @Post()
  @Permissions('role:create')
  @Audit('role:created', 'Role')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a custom role' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: '"super_admin" cannot be created here' })
  async create(
    @Body() dto: CreateRoleDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: RoleDetail }> {
    return { success: true, data: await this.roleService.create(dto, tenantId) };
  }

  @Patch(':id')
  @Permissions('role:update')
  @Audit('role:updated', 'Role')
  @ApiOperation({
    summary: 'Edit a role',
    description: 'Sending `permissions` replaces the whole grant; omitting it leaves it unchanged.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: RoleDetail }> {
    return { success: true, data: await this.roleService.update(id, dto, tenantId) };
  }

  @Delete(':id')
  @Permissions('role:delete')
  @Audit('role:deleted', 'Role')
  @ApiOperation({ summary: 'Delete a role. Refused while any member still holds it.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Role is assigned to at least one member' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { message: string } }> {
    return { success: true, data: await this.roleService.remove(id, tenantId) };
  }
}
