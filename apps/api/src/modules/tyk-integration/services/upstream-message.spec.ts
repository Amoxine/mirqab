import { neutraliseUpstreamMessage } from './upstream-message';

/** A name from the infrastructure, as a whole word (`_`, digits and hyphens do not join words). */
const INFRA_NAME =
  /(?<![A-Za-z0-9])(tyk|pump|redis|hydra|kratos|keto|ory|postgres|postgresql|prisma|oas)s?(?![A-Za-z0-9])/i;
/** An address of an internal service: a scheme://, a host:port, an IPv4. */
const INTERNAL_ADDRESS = /:\/\/|[a-z0-9-]+:\d{2,5}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/i;

describe('neutraliseUpstreamMessage', () => {
  it.each([
    [
      'Tyk Pump: redis timeout at http://tyk-gateway:8081/tyk/apis',
      'Analytics collector: data store timeout at an internal address',
    ],
    ['Redis connection refused at redis:6379', 'Data store connection refused at an internal address'],
    [
      'dial tcp 172.18.0.5:6379: connect: connection refused',
      'dial tcp an internal address: connect: connection refused',
    ],
    ['Postgres error: relation "tyk_analytics" does not exist', 'Data store error: relation "gateway_analytics" does not exist'],
    ['Hydra and Kratos are down; ory/keto too', 'Identity service and identity service are down; identity service/identity service too'],
    ['Invalid OAS document at tyk://mcp-1/mcp', 'Invalid OpenAPI document at an internal address'],
    ['The TYK GATEWAY cannot reach PostgreSQL', 'The gateway cannot reach data store'],
    ['Pumps stopped. Redis is full', 'Analytics collector stopped. Data store is full'],
  ])('turns %j into %j', (hostile, neutral) => {
    expect(neutraliseUpstreamMessage(hostile)).toBe(neutral);
  });

  it.each([
    'Api ID must be unique',
    'Field "listen_path" is required',
    'Key not found',
    'Request body has an invalid JSON shape at line 12',
    'Quota max must be -1 or at least 0',
  ])('keeps the validation hint %j exactly as it is', (hint) => {
    expect(neutraliseUpstreamMessage(hint)).toBe(hint);
  });

  it('leaves no infrastructure name or internal address in a hostile body, and is idempotent', () => {
    const hostile = [
      'Tyk Pump: redis timeout at http://tyk-gateway:8081/tyk/apis',
      'REDIS_URL=redis://redis:6379/0 refused; Tyk-Gateway gateway at 10.0.0.7:8080 down',
      'tyk_gateway_1 exited; hydra:4445 and kratos:4433 unreachable; pump, Pumps, postgresql://u:p@db:5432/x',
    ];
    for (const text of hostile) {
      const cleaned = neutraliseUpstreamMessage(text);
      expect(cleaned).not.toMatch(INFRA_NAME);
      expect(cleaned).not.toMatch(INTERNAL_ADDRESS);
      expect(neutraliseUpstreamMessage(cleaned)).toBe(cleaned);
    }
  });
});
