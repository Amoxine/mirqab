import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import type { WebhookDelivery } from '@prisma/client';
import { WebhookSubscriptionService, type WebhookSubscriptionDetail } from '../services/webhook-subscription.service';
import { CreateWebhookSubscriptionDto } from '../dto/create-webhook-subscription.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import type { PaginatedResult } from '../../api-management/services/api.service';

/**
 * WP27, dashboard-facing. Reuses the `api:*` permission family rather than a new one — a webhook
 * subscription is configuration ON an API, the same relationship an API's rate limit or CORS
 * config already has, so create/delete gate on `api:update` and reads gate on `api:read`.
 */
@ApiTags('Webhooks')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly subscriptions: WebhookSubscriptionService) {}

  @Post()
  @Permissions('api:update')
  @ApiOperation({
    summary: 'Subscribe to an API\'s events (quota breach, auth failure, upstream down)',
    description:
      'The signing secret is returned ONLY in this response, exactly once — the same contract as ' +
      'a Tyk key. OAS-format APIs only (400 for CLASSIC); a receiver URL on the SSRF deny list also answers 400.',
  })
  @Audit('webhook:created', 'WebhookSubscription')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateWebhookSubscriptionDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: WebhookSubscriptionDetail }> {
    return { success: true, data: await this.subscriptions.create(dto, tenantId) };
  }

  @Get()
  @Permissions('api:read')
  @ApiOperation({ summary: 'List this tenant\'s webhook subscriptions' })
  @ApiQuery({ name: 'apiId', required: false })
  async findAll(
    @CurrentTenant() tenantId: string,
    @Query('apiId') apiId?: string,
  ): Promise<{ success: true; data: WebhookSubscriptionDetail[] }> {
    return { success: true, data: await this.subscriptions.findAll(tenantId, apiId) };
  }

  @Get(':id')
  @Permissions('api:read')
  @ApiOperation({ summary: 'Get one webhook subscription' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: WebhookSubscriptionDetail }> {
    return { success: true, data: await this.subscriptions.findOne(id, tenantId) };
  }

  @Get(':id/deliveries')
  @Permissions('api:read')
  @ApiOperation({ summary: 'Delivery log for one webhook subscription' })
  async deliveries(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
  ): Promise<{ success: true; data: PaginatedResult<WebhookDelivery> }> {
    return { success: true, data: await this.subscriptions.deliveries(id, tenantId, page, pageSize) };
  }

  @Delete(':id')
  @Permissions('api:update')
  @ApiOperation({ summary: 'Unsubscribe' })
  @Audit('webhook:deleted', 'WebhookSubscription')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ message: string }> {
    return this.subscriptions.remove(id, tenantId);
  }
}
