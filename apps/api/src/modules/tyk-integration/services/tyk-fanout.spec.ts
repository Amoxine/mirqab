import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { TykClientService } from './tyk-client.service';
import type { CircuitBreakerService } from '../../../common/circuit-breaker/circuit-breaker.service';
import { CircuitBreakerOpenError } from '../../../common/circuit-breaker/circuit-breaker.types';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/** Cache invalidation deletes Tyk's own Redis keys (see `tykCacheKeyPattern`); these suites never
 *  exercise that path, so an empty SCAN is all they need. */
const fakeRedis = () =>
  ({ getClient: () => ({ scan: () => Promise.resolve(['0', []]), del: () => Promise.resolve(0) }) }) as never;

const NODES = 'http://n1:8081/tyk,http://n2:8081/tyk,http://n3:8081/tyk';

/**
 * Records every circuit name it is asked to execute under, and can be told that one specific node's
 * circuit is OPEN — which is exactly the state a dead node leaves behind.
 *
 * Deliberately does NOT invoke the wrapped function: these node URLs do not resolve, and a real
 * `fetch` would spend seconds failing DNS per node. The unit under test is the circuit KEYING and
 * the fan-out's error handling, neither of which needs a socket.
 */
function fakeBreaker(openFor: string[] = []) {
  const names: string[] = [];
  const okResponse = { ok: true, status: 200, json: () => Promise.resolve({}) };
  const service = {
    names,
    execute: jest.fn((name: string) => {
      names.push(name);
      return Promise.resolve(
        openFor.some((o) => name.includes(o))
          ? { success: false as const, error: new CircuitBreakerOpenError(name, 1000) }
          : { success: true as const, data: okResponse },
      );
    }),
  };
  return service;
}

function makeClient(breaker: ReturnType<typeof fakeBreaker>, nodes = NODES) {
  const config = {
    get: (key: string, fallback = '') =>
      ({
        TYK_ADMIN_URL: 'http://n1:8081/tyk',
        TYK_ADMIN_SECRET: 'secret',
        TYK_GATEWAY_URL: 'http://n1:8081',
        TYK_ADMIN_URLS: nodes,
      })[key] ?? fallback,
  };
  return new TykClientService(config as unknown as ConfigService, breaker as unknown as CircuitBreakerService,
    fakeRedis(),);
}

describe('WP13a fan-out and the per-node circuit breaker', () => {
  it('keys one circuit per node, never a single shared one', () => {
    const breaker = fakeBreaker();
    const client = makeClient(breaker);

    return client
      .forEachNode((nodeUrl) => Promise.resolve(nodeUrl))
      .then(() => {
        // The fan-out itself does not call the breaker; the per-node request does. Drive one.
        return client.getApiFromNode('og-1', 'http://n2:8081/tyk').catch(() => undefined);
      })
      .then(() => {
        expect(breaker.names).toEqual(['tyk:http://n2:8081/tyk']);
        // The pre-WP13a bug was this being the bare constant for every node.
        expect(breaker.names[0]).not.toBe('tyk');
      });
  });

  it('exposes every configured node, in order', () => {
    expect([...makeClient(fakeBreaker()).nodes]).toEqual([
      'http://n1:8081/tyk',
      'http://n2:8081/tyk',
      'http://n3:8081/tyk',
    ]);
  });

  it('forEachNode returns one outcome per node and never throws when a node fails', async () => {
    const client = makeClient(fakeBreaker());
    const outcomes = await client.forEachNode((nodeUrl) => {
      if (nodeUrl.includes('n3')) throw new Error('connect ECONNREFUSED');
      return Promise.resolve('ok');
    });

    expect(outcomes).toHaveLength(3);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    const failed = outcomes.find((o) => !o.ok);
    expect(failed?.nodeUrl).toBe('http://n3:8081/tyk');
    expect(failed?.error).toContain('ECONNREFUSED');
  });

  it('a dead node does NOT stop the healthy nodes being written — the actual WP13a fix', async () => {
    // node 3's circuit is OPEN, as it would be after repeated failures. Before the re-keying this
    // single open circuit was shared, so nodes 1 and 2 were refused too and the whole sync 503'd.
    const breaker = fakeBreaker(['n3']);
    const client = makeClient(breaker);

    const outcomes = await client.forEachNode((nodeUrl) =>
      client.getApiFromNode('og-1', nodeUrl).then(
        () => 'written',
        (err: unknown) => {
          throw err;
        },
      ),
    );

    expect(outcomes.map((o) => o.nodeUrl)).toEqual([
      'http://n1:8081/tyk',
      'http://n2:8081/tyk',
      'http://n3:8081/tyk',
    ]);
    expect(outcomes[2].ok).toBe(false);
    // Nodes 1 and 2 were still attempted under their OWN circuit names.
    expect(breaker.names).toContain('tyk:http://n1:8081/tyk');
    expect(breaker.names).toContain('tyk:http://n2:8081/tyk');
  });

  it('a single-node stack still produces exactly one node and one circuit', async () => {
    const breaker = fakeBreaker();
    const client = makeClient(breaker, '');
    expect([...client.nodes]).toEqual(['http://n1:8081/tyk']);
    await client.getApiFromNode('og-1', 'http://n1:8081/tyk').catch(() => undefined);
    expect(breaker.names).toEqual(['tyk:http://n1:8081/tyk']);
  });
});
