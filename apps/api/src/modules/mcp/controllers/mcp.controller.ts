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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { McpService, type McpServerDetail } from '../services/mcp.service';
import type { NodeOutcome } from '../../tyk-integration/services/tyk-client.service';
import { CreateMcpServerDto, UpdateMcpServerDto } from '../dto/mcp-server.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

/**
 * MCP servers (WP28).
 *
 * **No `mcp:*` permission family, deliberately.** An MCP proxy is another API this tenant publishes
 * through the same gateway, so it reuses `api:read|create|update|delete`; binding a tool to a plan
 * is a read of that plan, so it reuses `plan:read`. A parallel permission family would have to be
 * granted to every role that already administers APIs, and the first role that was missed would be
 * an admin who can edit an API but not the MCP proxy in front of it.
 */
@ApiTags('MCP')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('mcps')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Post()
  @Permissions('api:create', 'plan:read')
  @ApiOperation({
    summary: 'Register an MCP server in front of an existing OAS API',
    description:
      'The source API is never modified: Tyk derives the tool catalogue from its OpenAPI document ' +
      'and translates each `tools/call` back into the REST operation the tool names. The proxy is ' +
      'always `authToken`-protected — tool access control is expressed through key policies, so a ' +
      'keyless MCP proxy could carry no tool grants at all.',
  })
  @ApiResponse({ status: 201, description: 'Registered and pushed to every gateway node' })
  @ApiResponse({ status: 400, description: 'The source API is missing, CLASSIC-format, or not yet synced' })
  @ApiResponse({ status: 409, description: 'The slug or listen path is already taken in this tenant' })
  @Audit('api:created', 'McpServer')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateMcpServerDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: McpServerDetail }> {
    return { success: true, data: await this.mcpService.create(dto, tenantId) };
  }

  @Get()
  @Permissions('api:read')
  @ApiOperation({ summary: 'The MCP server catalogue for this tenant' })
  async findAll(
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: McpServerDetail[] }> {
    return { success: true, data: await this.mcpService.findAll(tenantId) };
  }

  @Get(':id')
  @Permissions('api:read')
  @ApiOperation({ summary: 'One MCP server, with its tool catalogue' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: McpServerDetail }> {
    return { success: true, data: await this.mcpService.findOne(id, tenantId) };
  }

  @Patch(':id')
  @Permissions('api:update', 'plan:read')
  @ApiOperation({
    summary: 'Edit an MCP server, including its tool catalogue and plan bindings',
    description:
      '`tools` replaces the catalogue wholesale. Changing it also re-pushes the tool grant of every ' +
      'key already scoped to this server, so a withdrawn binding stops working on existing ' +
      'credentials rather than only on new ones.',
  })
  @Audit('api:updated', 'McpServer')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMcpServerDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: McpServerDetail }> {
    return { success: true, data: await this.mcpService.update(id, dto, tenantId) };
  }

  @Delete(':id')
  @Permissions('api:delete')
  @ApiOperation({ summary: 'Delete an MCP server and remove its proxy from every node' })
  @Audit('api:deleted', 'McpServer')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { message: string; nodes: NodeOutcome[] } }> {
    return { success: true, data: await this.mcpService.remove(id, tenantId) };
  }

  @Post(':id/sync')
  @Permissions('api:sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-push this MCP server to every gateway node',
    description:
      '200 when every node accepted it, 207 when at least one did not — the same contract as ' +
      '`POST /apis/:id/sync`, and for the same reason: a proxy live on some nodes and absent on ' +
      'others is not a success.',
  })
  @ApiResponse({ status: 207, description: 'At least one gateway node did not accept the definition' })
  @Audit('api:sync_succeeded', 'McpServer')
  async sync(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true; data: McpServerDetail & { nodes: NodeOutcome[] } }> {
    const { detail, nodes } = await this.mcpService.syncNow(id, tenantId);
    if (nodes.some((n) => !n.ok)) res.status(HttpStatus.MULTI_STATUS);
    return { success: true, data: { ...detail, nodes } };
  }
}
