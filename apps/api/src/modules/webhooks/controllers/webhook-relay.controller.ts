import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Param, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { WebhookRelayService } from '../services/webhook-relay.service';
import { WEBHOOK_RELAY_SECRET_HEADER } from '../webhook-relay.constants';

/** Constant-time compare so a wrong guess cannot be timed byte-by-byte. Length-safe: `timingSafeEqual` throws on a mismatched length rather than comparing. */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * WP27. The URL Tyk's own event handlers call (`webhook-relay.constants.ts`), never the tenant's
 * `receiverUrl` directly. `@Public()` because Tyk carries no dashboard session — but this same
 * process also answers on the edge's published API port, so it is reachable from outside the
 * compose network too, which is exactly why every call is required to carry the shared-secret
 * header configured into Tyk's own event handler config. Missing/wrong secret -> 401, same as any
 * other failed auth, not a 404 that would tell a prober whether the api id exists.
 */
@Controller('webhooks/relay')
export class WebhookRelayController {
  private readonly logger = new Logger(WebhookRelayController.name);

  constructor(private readonly relay: WebhookRelayService) {}

  @Public()
  @Post(':apiId')
  @HttpCode(HttpStatus.OK)
  relayEvent(
    @Param('apiId') apiId: string,
    @Headers(WEBHOOK_RELAY_SECRET_HEADER.toLowerCase()) secret: string | undefined,
    @Body() payload: Record<string, unknown>,
  ): { received: true } {
    const expected = process.env.TYK_WEBHOOK_RELAY_SECRET ?? '';
    if (!expected || !secret || !secretsMatch(secret, expected)) {
      throw new UnauthorizedException('Invalid relay secret');
    }

    // Fire-and-forget, like every other background sync in this codebase (`api.service.ts`'s
    // `syncInBackground`): Tyk does not wait on this call's body, and the retry loop inside can run
    // several seconds past whatever timeout Tyk itself applies to firing the webhook.
    this.relay.relay(apiId, payload).catch((err: unknown) => {
      this.logger.error(`Webhook relay failed for api ${apiId}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return { received: true };
  }
}
