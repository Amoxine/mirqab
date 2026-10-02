import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiDefFormat, ApiProtocol, type WebhookDelivery, type WebhookSubscription } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { CreateWebhookSubscriptionDto } from '../dto/create-webhook-subscription.dto';
import { ApiService, type PaginatedResult } from '../../api-management/services/api.service';

const MAX_PAGE_SIZE = 100;

export interface WebhookSubscriptionDetail {
  id: string;
  apiId: string;
  receiverUrl: string;
  active: boolean;
  createdAt: Date;
  /** Present ONLY on the create response — see `create()`. Same one-time-return contract as a Tyk key. */
  secret?: string;
}

function toDetail(row: WebhookSubscription, secret?: string): WebhookSubscriptionDetail {
  return {
    id: row.id,
    apiId: row.apiId,
    receiverUrl: row.receiverUrl,
    active: row.active,
    createdAt: row.createdAt,
    ...(secret === undefined ? {} : { secret }),
  };
}

/**
 * WP27. Owns the `WebhookSubscription`/`WebhookDelivery` rows and the one bit (`ApiDefinition.webhooksEnabled`)
 * that makes `mapToTykOas` add the eventHandlers block. Delivery itself — redaction, signing, retry,
 * the delivery log — is `webhook-relay.service.ts`'s job; this service never talks to Tyk directly,
 * it flips the flag and reuses `ApiService.syncNowWithNodes` (already the fan-out/mapper pipeline
 * every other WP's config change goes through) to push it.
 */
@Injectable()
export class WebhookSubscriptionService {
  constructor(private readonly apiService: ApiService) {}

  private async findApiRow(apiId: string, tenantId: string) {
    const apiDef = await prisma.apiDefinition.findUnique({ where: { id: apiId } });
    if (apiDef?.tenantId !== tenantId) {
      throw new NotFoundException(`API ${apiId} not found`);
    }
    return apiDef;
  }

  private async findRow(id: string, tenantId: string): Promise<WebhookSubscription> {
    const row = await prisma.webhookSubscription.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Webhook subscription ${id} not found`);
    if (row.tenantId !== tenantId) throw new ForbiddenException('This webhook subscription belongs to another tenant');
    return row;
  }

  async create(dto: CreateWebhookSubscriptionDto, tenantId: string): Promise<WebhookSubscriptionDetail> {
    const apiDef = await this.findApiRow(dto.apiId, tenantId);

    // S1's verified probe used `x-tyk-api-gateway.server.eventHandlers` — the OAS shape. CLASSIC's
    // `event_handlers.events` map is a different, unverified shape; refusing here rather than
    // guessing at it (see WP27's report to team-lead).
    if (apiDef.defFormat !== ApiDefFormat.OAS) {
      throw new BadRequestException(
        'Webhooks require an API defined from an OpenAPI document; this API uses a classic definition',
      );
    }
    // A TCP api has no HTTP-layer middleware at all (confirmed against the v5.15.0 source) — none of
    // QuotaExceeded/AuthFailure/BreakerTripped can ever fire for one.
    if (apiDef.protocol === ApiProtocol.TCP) {
      throw new BadRequestException('Webhooks are not available on a TCP-passthrough API');
    }

    const secret = randomBytes(32).toString('base64url');
    const row = await prisma.webhookSubscription.create({
      data: { tenantId, apiId: dto.apiId, receiverUrl: dto.receiverUrl, secret, active: true },
    });

    if (!apiDef.webhooksEnabled) {
      await prisma.apiDefinition.update({ where: { id: apiDef.id }, data: { webhooksEnabled: true } });
      await this.apiService.syncNowWithNodes(apiDef.id, tenantId);
    }

    // The only place the raw secret is ever returned — matches the Tyk key contract
    // (`tyk-client.service.ts:186-196`, `keyHash` stored, raw value never persisted anywhere).
    return toDetail(row, secret);
  }

  async findAll(tenantId: string, apiId?: string): Promise<WebhookSubscriptionDetail[]> {
    const rows = await prisma.webhookSubscription.findMany({
      where: { tenantId, ...(apiId ? { apiId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => toDetail(row));
  }

  async findOne(id: string, tenantId: string): Promise<WebhookSubscriptionDetail> {
    return toDetail(await this.findRow(id, tenantId));
  }

  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const row = await this.findRow(id, tenantId);
    await prisma.webhookSubscription.delete({ where: { id: row.id } });

    const remaining = await prisma.webhookSubscription.count({ where: { apiId: row.apiId, active: true } });
    if (remaining === 0) {
      await prisma.apiDefinition.update({ where: { id: row.apiId }, data: { webhooksEnabled: false } });
      await this.apiService.syncNowWithNodes(row.apiId, tenantId);
    }

    return { message: 'Webhook subscription deleted' };
  }

  async deliveries(
    id: string,
    tenantId: string,
    page = 1,
    pageSize = 20,
  ): Promise<PaginatedResult<WebhookDelivery>> {
    const subscription = await this.findRow(id, tenantId);
    const safePage = Math.max(1, page);
    const take = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);

    const [data, totalCount] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where: { subscriptionId: subscription.id },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * take,
        take,
      }),
      prisma.webhookDelivery.count({ where: { subscriptionId: subscription.id } }),
    ]);

    return { data, meta: { page: safePage, pageSize: take, totalCount, totalPages: Math.ceil(totalCount / take) } };
  }
}
