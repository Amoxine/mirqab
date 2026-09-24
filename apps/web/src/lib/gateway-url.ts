// An unset OR empty NEXT_PUBLIC_GATEWAY_URL must fall back, so this is not a `??`.
const configuredGatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? '';

/** The gateway's own data-plane origin (infra/edge/Caddyfile) — what the try-it console calls
 * directly from the browser, with the developer's own key. Never the management api. */
export const GATEWAY_URL = configuredGatewayUrl === '' ? 'https://localhost:33005' : configuredGatewayUrl;
