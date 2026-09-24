/**
 * WP27 — the pieces `tyk-mappers.ts` (api-management) and the webhooks module both need, kept
 * dependency-free (no NestJS DI) so the mapper — a pure function — can import it directly without
 * reaching into another module's providers.
 */

/**
 * Header Tyk's webhook handler is configured to send back to our own relay endpoint
 * (`webhook-relay.controller.ts`). That endpoint is `@Public()` and, being served by this same
 * process, is reachable both in-network (from Tyk) and through the edge's published API port like
 * any other route — this header is what stops an outside caller from forging a Tyk event.
 */
export const WEBHOOK_RELAY_SECRET_HEADER = 'X-Tyk-Webhook-Relay-Secret';

/**
 * Read once per call, not cached, matching `proxy-url.validator.ts`'s `extraDeniedHosts()` — a
 * config change needs no restart. Empty in a dev checkout with no `.env` override; the relay
 * controller then refuses every call (fail closed), which only matters once a subscription exists.
 */
function relaySecret(): string {
  return process.env.TYK_WEBHOOK_RELAY_SECRET ?? '';
}

/**
 * The three native Tyk event triggers this WP wires up — S1's own caveat list names exactly these
 * three (`ralplan-gateway-competitive-roadmap-appendix.md`, S1 row). "Upstream down" is
 * `BreakerTripped`, not `HostDown`: `HostDown` fires off Tyk's uptime-test poll, whose interval is a
 * gateway-global setting with no fast per-API override in this stack — risking the 10s bound —
 * while `BreakerTripped` fires on real failed requests and reuses the per-operation circuit breaker
 * `tyk-mappers.ts` already wires into the OAS mapper (WP16), so it needs nothing new to trip fast.
 */
export const WEBHOOK_EVENT_TRIGGERS = ['QuotaExceeded', 'AuthFailure', 'BreakerTripped'] as const;
export type WebhookEventTrigger = (typeof WEBHOOK_EVENT_TRIGGERS)[number];

/**
 * In-network URL Tyk's own event handler calls — never the tenant's `receiverUrl` directly.
 * `api:4000` is this same process's own compose network alias (`main.ts`'s `PORT`, `docker-compose.yml`).
 */
export function webhookRelayUrl(apiId: string): string {
  return `http://api:4000/api/webhooks/relay/${apiId}`;
}

/**
 * `x-tyk-api-gateway.server.eventHandlers` entries (S1's verified shape, `X-Tyk-Webhook-Without-ID`)
 * for one API. Called from `mapToTykOas` whenever `ApiDefinition.webhooksEnabled` is true.
 */
export function buildTykEventHandlers(apiId: string): Record<string, unknown>[] {
  return WEBHOOK_EVENT_TRIGGERS.map((trigger) => ({
    enabled: true,
    trigger,
    type: 'webhook',
    name: `og-webhook-${trigger.toLowerCase()}`,
    url: webhookRelayUrl(apiId),
    method: 'POST',
    // Required by the schema; "" falls back to Tyk's own built-in template (S1 caveat 2) — the relay
    // reads `event`/`message`/`path`/`key` off that default shape, not a custom one.
    cooldownPeriod: '0s',
    bodyTemplate: '',
    headers: [{ name: WEBHOOK_RELAY_SECRET_HEADER, value: relaySecret() }],
  }));
}
