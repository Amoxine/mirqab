import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { DeveloperAuthGuard } from '../guards/developer-auth.guard';
import { CurrentDeveloper } from '../decorators/current-developer.decorator';
import type { DeveloperPayload } from '../../../common/types';
import { SubscriptionService, type SubscriptionDetail } from '../services/subscription.service';
import { CreateSubscriptionDto } from '../dto/create-subscription.dto';
import { KEY_USAGE_RANGES, type KeyUsageDto, type KeyUsageRange } from '../../keys/dto/key-usage.dto';

@ApiTags('Portal')
@ApiBearerAuth()
@Public()
@UseGuards(DeveloperAuthGuard)
@Controller('portal/applications/:applicationId/subscriptions')
export class PortalSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // Abuse control (plan acceptance): issuing a key is the expensive, abusable step.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Subscribe an application to a product at a plan tier',
    description:
      'A plan with requiresApproval:false (the default) issues the key in this same call — the ' +
      'response then carries keyValue once. requiresApproval:true leaves the subscription PENDING ' +
      'with no key at all.',
  })
  @ApiResponse({ status: 403, description: 'The application belongs to a different account' })
  @ApiResponse({ status: 404, description: 'Product or plan not found in this tenant' })
  @ApiResponse({ status: 409, description: 'Already subscribed to this product' })
  async create(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() dto: CreateSubscriptionDto,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<SubscriptionDetail> {
    return this.subscriptions.create(dto, applicationId, developer.sub, developer.tenantId);
  }

  @Get()
  @ApiOperation({ summary: 'This application\'s subscriptions' })
  async findAll(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<SubscriptionDetail[]> {
    return this.subscriptions.findAllForApplication(applicationId, developer.sub);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a subscription — its key stops working immediately' })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<SubscriptionDetail> {
    return this.subscriptions.revoke(id, developer.sub);
  }

  @Get(':id/usage')
  @ApiQuery({ name: 'range', required: false, enum: KEY_USAGE_RANGES })
  @ApiOperation({ summary: 'This subscription\'s own consumption against its plan\'s allowance' })
  async usage(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDeveloper() developer: DeveloperPayload,
    @Query('range') range?: KeyUsageRange,
  ): Promise<KeyUsageDto> {
    return this.subscriptions.getUsage(id, developer.sub, range);
  }
}
