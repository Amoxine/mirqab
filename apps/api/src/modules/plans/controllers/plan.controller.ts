import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PlanService, type PlanDetail } from '../services/plan.service';
import { CreatePlanDto, UpdatePlanDto } from '../dto/plan.dto';
import type { NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

@ApiTags('Plans')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('plans')
export class PlanController {
  constructor(private readonly plans: PlanService) {}

  @Post()
  @Permissions('plan:create')
  @ApiOperation({
    summary: 'Create a plan',
    description: 'Creates the plan and pushes its Tyk policy to every node before returning.',
  })
  @ApiResponse({ status: 201, description: 'Plan created and its policy live on every node' })
  @Audit('plan:created', 'Plan')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreatePlanDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: PlanDetail }> {
    return { success: true, data: await this.plans.create(dto, tenantId) };
  }

  @Get()
  @Permissions('plan:read')
  @ApiOperation({ summary: 'List plans' })
  async findAll(@CurrentTenant() tenantId: string): Promise<{ success: true; data: PlanDetail[] }> {
    return { success: true, data: await this.plans.findAll(tenantId) };
  }

  @Get(':id')
  @Permissions('plan:read')
  @ApiOperation({ summary: 'Get a plan' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: PlanDetail }> {
    return { success: true, data: await this.plans.findOne(id, tenantId) };
  }

  @Patch(':id')
  @Permissions('plan:update')
  @ApiOperation({
    summary: 'Update a plan',
    description:
      'Re-pushes one policy. Every key assigned to this plan picks up the new limit; no key is touched.',
  })
  @Audit('plan:updated', 'Plan')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: PlanDetail }> {
    return { success: true, data: await this.plans.update(id, dto, tenantId) };
  }

  @Post(':id/sync')
  @Permissions('plan:update')
  @ApiOperation({ summary: 'Re-push this plan’s policy to every node' })
  // `updated`, not `sync_succeeded`: this route answers 200 with per-node outcomes even when a node
  // failed, so claiming success would overstate; and `synced` is not an AuditAction value at all.
  @Audit('plan:updated', 'Plan')
  @HttpCode(HttpStatus.OK)
  async sync(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { nodes: NodeOutcome[] } }> {
    return { success: true, data: { nodes: await this.plans.syncPolicy(id, tenantId) } };
  }

  @Delete(':id')
  @Permissions('plan:delete')
  @ApiOperation({
    summary: 'Delete a plan',
    description: 'Keys assigned to it survive and become plan-less; they are never deleted with it.',
  })
  @Audit('plan:deleted', 'Plan')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { message: string; unassignedKeys: number } }> {
    return { success: true, data: await this.plans.remove(id, tenantId) };
  }
}
