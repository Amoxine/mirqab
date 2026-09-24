import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { WebhookDeliveryStatus, type WebhookSubscription } from '@prisma/client';
import { prisma } from '@open-gateway/database';

/**
 * Tyk's default webhook body template (S1 probe): `{event, message, path, origin, key}`. `key` is
 * the live Tyk key's raw value (S1 caveat 3) and is deliberately NOT part of this type — `redact()`
 * below drops it before anything leaves this process, so a tenant's `receiverUrl` never becomes a
 * secret-bearing sink even though it already passed the SSRF egress check at subscribe time.
 */
interface TykWebhookPayload {
  event?: string;
  message?: string;
  path?: string;
  [key: string]: unknown;
}

// 3 attempts total: immediate, then two backoff delays. Happy path (receiver up) always lands on
// the first, well inside the 10s acceptance bound — S1 already measured Tyk's own firing as
// "well inside 10s" and this adds one in-process HTTP hop on top of it.
const RETRY_DELAYS_MS = [0, 500, 1500];
const DELIVERY_TIMEOUT_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function redact(payload: TykWebhookPayload): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring to drop `key`, not to use it
  const { key, ...rest } = payload;
  return rest;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * WP27. What native Tyk webhooks cannot do on their own: sign the payload, redact the live key,
 * retry with backoff, and leave a delivery log — the whole reason this WP relays through our own
 * process rather than pointing Tyk's event handler straight at the tenant's `receiverUrl`.
 */
@Injectable()
export class WebhookRelayService {
  private readonly logger = new Logger(WebhookRelayService.name);

  /** Fans out to every active subscription this API has. Tyk does not wait on the response body. */
  async relay(apiId: string, payload: TykWebhookPayload): Promise<void> {
    const subscriptions = await prisma.webhookSubscription.findMany({ where: { apiId, active: true } });
    if (subscriptions.length === 0) return;

    const body = JSON.stringify(redact(payload));
    const eventType = typeof payload.event === 'string' ? payload.event : 'unknown';

    await Promise.all(subscriptions.map((subscription) => this.deliver(subscription, eventType, body)));
  }

  private async deliver(subscription: WebhookSubscription, eventType: string, body: string): Promise<void> {
    const signature = sign(body, subscription.secret);
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      attempts += 1;

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, DELIVERY_TIMEOUT_MS);
      try {
        const res = await fetch(subscription.receiverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': `sha256=${signature}` },
          body,
          signal: controller.signal,
        });
        lastStatus = res.status;
        if (res.ok) {
          await this.log(subscription.id, eventType, attempts, WebhookDeliveryStatus.SUCCESS, res.status);
          return;
        }
        lastError = `HTTP ${String(res.status)}`;
      } catch (err) {
        lastError = (err as Error).message;
      } finally {
        clearTimeout(timeout);
      }
    }

    this.logger.warn(
      `Webhook delivery failed after ${String(attempts)} attempts: subscription=${subscription.id} ${lastError ?? ''}`,
    );
    await this.log(subscription.id, eventType, attempts, WebhookDeliveryStatus.FAILED, lastStatus, lastError);
  }

  private async log(
    subscriptionId: string,
    eventType: string,
    attempts: number,
    status: WebhookDeliveryStatus,
    responseStatus?: number,
    error?: string,
  ): Promise<void> {
    await prisma.webhookDelivery.create({
      data: { subscriptionId, eventType, attempts, status, responseStatus: responseStatus ?? null, error: error ?? null },
    });
  }
}
