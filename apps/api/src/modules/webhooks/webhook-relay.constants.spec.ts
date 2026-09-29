import 'reflect-metadata';
import {
  buildTykEventHandlers,
  REDACTED,
  redactRelaySecret,
  WEBHOOK_RELAY_SECRET_HEADER,
} from './webhook-relay.constants';

describe('redactRelaySecret', () => {
  const OLD = process.env.TYK_WEBHOOK_RELAY_SECRET;
  beforeAll(() => {
    process.env.TYK_WEBHOOK_RELAY_SECRET = 'super-secret-relay-value';
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.TYK_WEBHOOK_RELAY_SECRET;
    else process.env.TYK_WEBHOOK_RELAY_SECRET = OLD;
  });

  const doc = () => ({
    openapi: '3.0.3',
    info: { title: 'x' },
    'x-tyk-api-gateway': { server: { eventHandlers: buildTykEventHandlers('api-1') } },
  });

  it('blanks the secret in every event handler header and leaves the input untouched', () => {
    const input = doc();
    expect(JSON.stringify(input)).toContain('super-secret-relay-value'); // the fixture really carries it

    const out = redactRelaySecret(input);

    expect(JSON.stringify(out)).not.toContain('super-secret-relay-value');
    const handlers = out['x-tyk-api-gateway'].server.eventHandlers as {
      headers: { name: string; value: string }[];
    }[];
    expect(handlers).toHaveLength(3);
    for (const h of handlers) {
      expect(h.headers).toEqual([{ name: WEBHOOK_RELAY_SECRET_HEADER, value: REDACTED }]);
    }
    // not mutated: what is stored (and compared for drift) keeps the real value
    expect(JSON.stringify(input)).toContain('super-secret-relay-value');
  });

  it('keeps unrelated headers and passes through documents without event handlers', () => {
    const withOther = {
      'x-tyk-api-gateway': {
        server: {
          eventHandlers: [
            {
              headers: [
                { name: 'X-Other', value: 'keep' },
                { name: 'x-tyk-webhook-relay-secret', value: 's' },
              ],
            },
          ],
        },
      },
    };
    const out = redactRelaySecret(withOther);
    expect(JSON.stringify(out)).toContain('keep');
    expect(JSON.stringify(out)).not.toContain('"s"');

    expect(redactRelaySecret(null)).toBeNull();
    expect(redactRelaySecret({ openapi: '3.0.3' })).toEqual({ openapi: '3.0.3' });
  });
});
